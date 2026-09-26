/**
 * A minimal Chrome DevTools Protocol proxy that counts every CDP message that
 * crosses it.
 *
 * Why this exists: the performance claim we care about is "how many browser
 * protocol calls does one decision cycle cost". jev-ultrafast reports median
 * browser protocol calls falling from 1,092 to 101. That is only a meaningful
 * number if you can count protocol calls, and there is no supported way to ask
 * Playwright how many it sent. So we put ourselves in the middle: Chromium is
 * launched by us, Playwright connects to this proxy over CDP, and this proxy
 * forwards every frame to the real browser while tallying the `method` field of
 * each JSON message in each direction.
 *
 * No dependencies on purpose. `ws` is not in the dependency tree, and a
 * benchmark harness that can perturb the thing it measures by adding a package
 * is a worse benchmark. Node's crypto covers the one thing we need it for, the
 * RFC 6455 handshake accept key.
 *
 * Scope: this is measurement scaffolding, not production code. It speaks just
 * enough of the WebSocket framing to carry CDP: text and binary data frames,
 * continuation, ping/pong and close. It does not implement permessage-deflate
 * (we never negotiate it) and it does not validate UTF-8 payloads, because CDP
 * messages are JSON and a frame that fails to parse as JSON is counted as
 * unparseable rather than silently attributed to a method.
 */
import { createHash } from "node:crypto";
import http from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** RFC 6455 accept token for a client's Sec-WebSocket-Key. */
function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * Incremental WebSocket frame reader.
 *
 * TCP gives no message boundaries, so every chunk feeds a resynchronising
 * parser and whatever cannot be decoded yet is kept. A CDP response carrying a
 * screenshot easily exceeds 64 KiB, which is why the 64-bit length branch
 * exists; ignoring it would desynchronise the whole stream.
 */
class FrameReader {
  constructor({ expectMask }) {
    this.expectMask = expectMask;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return this.drain();
  }

  drain() {
    const out = [];
    for (;;) {
      const frame = this.readOne();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  readOne() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      // A frame larger than 2^53 cannot be a real CDP message; treat it as
      // corruption rather than allocating an unbounded buffer.
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`CDP frame length ${big} is not credible`);
      }
      len = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;

    let payload = Buffer.from(b.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

/** Serialises one frame. `mask` must be true when this side is the WS client. */
function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = mask ? 0x80 | len : len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = mask ? 0x80 | 126 : 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = mask ? 0x80 | 127 : 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // always FIN: CDP never fragments in practice
  if (!mask) return Buffer.concat([header, payload]);

  const key = Buffer.from([0, 0, 0, 0]);
  for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
  return Buffer.concat([header, key, payload]);
}

/** Accumulates continuation frames into whole messages. */
class MessageAssembler {
  constructor() {
    this.pending = null;
  }

  push(frame) {
    if (frame.opcode === 0x9) return { kind: "ping", payload: frame.payload };
    if (frame.opcode === 0xa) return { kind: "pong", payload: frame.payload };
    if (frame.opcode === 0x8) return { kind: "close" };
    if (frame.opcode === 0x0) {
      if (!this.pending) return null;
      this.pending.payload = Buffer.concat([this.pending.payload, frame.payload]);
    } else {
      this.pending = { opcode: frame.opcode, payload: Buffer.from(frame.payload) };
    }
    if (!frame.fin) return null;
    const done = this.pending;
    this.pending = null;
    return done ? { kind: "message", opcode: done.opcode, payload: done.payload } : null;
  }
}

/** Tally of CDP methods seen in one direction. */
class Counter {
  constructor(label) {
    this.label = label;
    this.total = 0;
    this.unparsed = 0;
    this.byMethod = new Map();
  }

  add(method) {
    this.total += 1;
    this.byMethod.set(method, (this.byMethod.get(method) ?? 0) + 1);
  }

  /** Records one wire message. Requests and responses both carry a `method`. */
  record(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      this.unparsed += 1;
      return;
    }
    if (msg && typeof msg.method === "string") this.add(msg.method);
  }

  report(top = 15) {
    const rows = [...this.byMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    return {
      label: this.label,
      total: this.total,
      unparsed: this.unparsed,
      top: rows.map(([method, count]) => ({ method, count })),
    };
  }

  reset() {
    this.total = 0;
    this.unparsed = 0;
    this.byMethod.clear();
  }
}

/**
 * Starts the proxy in front of a Chromium that is already listening for CDP.
 *
 * @param {object} opts
 * @param {number} opts.upstreamPort port Chromium exposes for CDP
 * @param {number} opts.proxyPort    port to listen on for Playwright
 * @returns {Promise<{endpoint: string, counters: Counter[], close: () => Promise<void>,
 *   byDirection: () => object}>}
 */
export async function startCdpProxy({ upstreamPort, proxyPort }) {
  const counters = { toBrowser: new Counter("client->browser"), toClient: new Counter("browser->client") };
  const sockets = new Set();

  const version = await fetch(`http://127.0.0.1:${upstreamPort}/json/version`).then((r) => r.json());
  const upstreamWsPath = new URL(version.webSocketDebuggerUrl).pathname;

  const server = http.createServer((req, res) => {
    // Playwright asks for "/json/version" with a trailing slash, Chromium's own
    // handler does not expect one, and any other path is not ours to answer.
    const route = (req.url ?? "").replace(/\/+$/, "") || "/";
    if (route === "/json/version") {
      // Playwright reads this to learn the browser endpoint. It must point back
      // at us, or it connects to Chromium directly and we count nothing.
      const body = JSON.stringify({
        ...version,
        webSocketDebuggerUrl: `ws://127.0.0.1:${proxyPort}${upstreamWsPath}`,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (route === "/json/list" || route === "/json/close" || route.startsWith("/json/activate")) {
      fetch(`http://127.0.0.1:${upstreamPort}${route}`, { method: req.method })
        .then((r) => r.text())
        .then((text) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(text);
        })
        .catch((err) => {
          res.writeHead(502);
          res.end(String(err));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));

    // Now dial the real browser and splice the two frame streams together.
    const upstreamReq = http.request({
      port: upstreamPort,
      path: upstreamWsPath,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": createHash("sha1").update(String(Date.now())).digest("base64").slice(0, 24),
        "Sec-WebSocket-Version": "13",
      },
    });
    upstreamReq.on("upgrade", (upRes, upstreamSocket) => {
      upstreamSocket.setNoDelay(true);
      sockets.add(upstreamSocket);
      upstreamSocket.on("close", () => sockets.delete(upstreamSocket));

      const clientReader = new FrameReader({ expectMask: true });
      const upstreamReader = new FrameReader({ expectMask: false });
      const clientMsgs = new MessageAssembler();
      const upstreamMsgs = new MessageAssembler();

      // Playwright -> Chromium
      socket.on("data", (chunk) => {
        for (const frame of clientReader.push(chunk)) {
          const msg = clientMsgs.push(frame);
          if (!msg) continue;
          if (msg.kind === "ping") {
            upstreamSocket.write(encodeFrame(0xa, msg.payload, true));
            continue;
          }
          if (msg.kind === "close") {
            upstreamSocket.write(encodeFrame(0x8, Buffer.alloc(0), true));
            upstreamSocket.end();
            return;
          }
          if (msg.kind === "pong") continue;
          counters.toBrowser.record(msg.payload);
          upstreamSocket.write(encodeFrame(msg.opcode, msg.payload, true));
        }
      });

      // Chromium -> Playwright
      upstreamSocket.on("data", (chunk) => {
        for (const frame of upstreamReader.push(chunk)) {
          const msg = upstreamMsgs.push(frame);
          if (!msg) continue;
          if (msg.kind === "ping") {
            socket.write(encodeFrame(0xa, msg.payload, false));
            continue;
          }
          if (msg.kind === "close") {
            socket.write(encodeFrame(0x8, Buffer.alloc(0), false));
            socket.end();
            return;
          }
          if (msg.kind === "pong") continue;
          counters.toClient.record(msg.payload);
          socket.write(encodeFrame(msg.opcode, msg.payload, false));
        }
      });

      const drop = () => {
        sockets.delete(upstreamSocket);
        sockets.delete(socket);
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on("close", drop);
      upstreamSocket.on("close", drop);
      socket.on("error", drop);
      upstreamSocket.on("error", drop);
    });
    upstreamReq.on("error", () => socket.destroy());
    upstreamReq.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", resolve);
  });

  return {
    endpoint: `http://127.0.0.1:${proxyPort}`,
    counters,
    reset() {
      counters.toBrowser.reset();
      counters.toClient.reset();
    },
    report(top = 15) {
      return {
        clientToBrowser: counters.toBrowser.report(top),
        browserToClient: counters.toClient.report(top),
        // A request always has a matching response, so the larger of the two is
        // the honest "protocol calls" figure rather than their sum.
        protocolCalls: Math.max(counters.toBrowser.total, counters.toClient.total),
      };
    },
    async close() {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
