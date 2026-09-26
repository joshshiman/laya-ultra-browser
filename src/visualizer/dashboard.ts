/**
 * The dashboard page, served as a single self-contained document.
 *
 * No build step, no CDN, no framework: the whole point is that this works offline on
 * a machine whose only job is to drive a browser. It is emitted as a template string
 * so the server has exactly one file to serve.
 *
 * Two honesty rules shape the rendering:
 *
 *   1. Scores are labelled as uncalibrated. This checkpoint ships temperatures that
 *      laya-mlx has to clamp, and the vendor's own sweep found confidence carries no
 *      warning signal. A confident-looking bar would misrepresent that.
 *   2. Bars animate from zero to their measured value. The animation is a transition
 *      between two real numbers, not a simulated progression, so what you see moving is
 *      the arrival of the result rather than a guess at intermediate states.
 */
export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>laya-ultra-browser: ranking</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161b22;
    --panel-2: #1c232c;
    --line: #2a323d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --good: #3fb950;
    --bad: #f85149;
    --warn: #d29922;
    --bar: #388bfd;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 12px 20px;
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  }
  h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .stat { color: var(--muted); font-size: 12px; }
  .stat b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 5px; }
  .dot.live { background: var(--good); box-shadow: 0 0 0 3px rgba(63,185,80,.15); }
  .dot.down { background: var(--bad); }
  main { padding: 20px; display: grid; gap: 16px; max-width: 1100px; }

  .calib {
    border: 1px solid rgba(210,153,34,.4); background: rgba(210,153,34,.08);
    color: #e3b341; border-radius: 8px; padding: 10px 14px; font-size: 12px;
  }
  .calib b { color: #f0c674; }

  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .card > .head {
    padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--panel-2);
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  }
  .goal { font-weight: 600; }
  .tag {
    font-size: 11px; color: var(--muted); border: 1px solid var(--line);
    border-radius: 999px; padding: 1px 8px; white-space: nowrap;
  }
  .tag.pick { color: var(--accent); border-color: rgba(88,166,255,.45); }
  .tag.bad { color: var(--bad); border-color: rgba(248,81,73,.4); }
  .tag.good { color: var(--good); border-color: rgba(63,185,80,.4); }
  .spacer { flex: 1; }
  .when { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .5px; padding: 8px 14px;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 7px 14px; border-bottom: 1px solid rgba(42,50,61,.5); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr.picked { background: rgba(56,139,253,.09); }
  tr.picked td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  td.rank { width: 34px; color: var(--muted); font-variant-numeric: tabular-nums; }
  td.ref  { width: 74px; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
  td.name { max-width: 0; width: 55%; }
  td.name .nm { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.name .rl { color: var(--muted); font-size: 11px; }
  td.bar { width: 34%; }
  td.val { width: 76px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }

  .track { background: #21262d; border-radius: 4px; height: 8px; overflow: hidden; position: relative; }
  .fill {
    height: 100%; width: 0; border-radius: 4px;
    background: linear-gradient(90deg, #1f6feb, var(--bar));
    transition: width .45s cubic-bezier(.2,.7,.3,1);
  }
  tr.picked .fill { background: linear-gradient(90deg, #2ea043, var(--good)); }
  /* A flat top edge marks a score the model did not separate from its neighbours. */
  .fill.flat { background: linear-gradient(90deg, #6e7681, #8b949e); }

  .empty { color: var(--muted); padding: 28px 14px; text-align: center; }
  .act { font-size: 12px; }
  .act.ok { color: var(--good); }
  .act.no { color: var(--bad); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); }
  .foot { color: var(--muted); font-size: 11px; text-align: center; padding: 4px 0 24px; }
</style>
</head>
<body>
<header>
  <h1>laya-ultra-browser</h1>
  <span class="stat"><span id="dot" class="dot down"></span><span id="conn">connecting</span></span>
  <span class="spacer"></span>
  <span class="stat">calls <b id="nrank">0</b></span>
  <span class="stat">actions <b id="nact">0</b></span>
  <span class="stat">failed <b id="nbad">0</b></span>
</header>

<main>
  <div class="calib">
    <b>Scores below are uncalibrated.</b>
    This checkpoint ships temperatures that laya-mlx has to clamp, and the model was not
    tuned for picking web controls. Read the ranking as a shortlist, not a probability.
    Every write is verified by reading the value back, so a wrong pick shows up as a
    failed or unexpected write rather than a silent success.
  </div>
  <div id="feed"></div>
  <div class="foot">Served from the running MCP server. Nothing leaves this machine.</div>
</main>

<script>
(function () {
  var MAX_CARDS = 40;
  var feed = document.getElementById("feed");
  var nrank = 0, nact = 0, nbad = 0;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  // A card whose scores are all bunched at the top is not a confident answer. When the
  // gap between first and second is small, the leading bar is drawn flat and grey so it
  // is not read as a strong signal.
  function spread(list) {
    if (!list.length) return 1;
    var xs = list.map(function (c) { return c.score; });
    return Math.max.apply(null, xs) - Math.min.apply(null, xs);
  }

  function renderRank(ev) {
    nrank++;
    nrankEl.textContent = nrank;

    var list = (ev.considered || []).slice().sort(function (a, b) { return b.score - a.score; });
    var spread_ = spread(list);
    var card = document.createElement("div");
    card.className = "card";

    var head = '<div class="head">' +
      '<span class="goal">' + esc(ev.goal) + "</span>" +
      '<span class="tag">' + esc(ev.mode) + "</span>" +
      '<span class="tag">' + list.length + " of " + ev.total + " candidates</span>" +
      (ev.pruned ? '<span class="tag">' + ev.pruned + " pruned</span>" : "") +
      (ev.disagreedWithDeterministic ? '<span class="tag bad">model and fallback disagree</span>' : "") +
      '<span class="spacer"></span>' +
      '<span class="when">' + ev.elapsedMs + " ms &middot; " + ago(ev.at) + "</span>" +
      "</div>";

    var body;
    if (ev.error) {
      body = '<div class="empty">call failed: ' + esc(ev.error) + "</div>";
    } else if (!list.length) {
      body = '<div class="empty">no candidates reached the model</div>';
    } else {
      var rows = list.map(function (c, i) {
        var picked = ev.selectedRef === c.ref;
        var flat = spread_ < 0.05;
        return '<tr class="' + (picked ? "picked" : "") + '">' +
          '<td class="rank">' + (i + 1) + "</td>" +
          '<td class="ref">ref ' + c.ref + "</td>" +
          '<td class="name"><span class="nm">' + esc(c.name || "(unnamed)") + "</span>" +
            '<span class="rl">' + esc(c.role || "") + "</span></td>" +
          '<td class="bar"><div class="track"><div class="fill' + (flat ? " flat" : "") +
            '" data-w="' + (c.score * 100).toFixed(2) + '"></div></div></td>' +
          '<td class="val">' + c.score.toFixed(3) + "</td>" +
          "</tr>";
      }).join("");
      body = "<table><thead><tr><th></th><th>ref</th><th>candidate</th>" +
        "<th>score</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    card.innerHTML = head + body;
    feed.insertBefore(card, feed.firstChild);

    // Animate after insertion so the transition has a start value to move from.
    requestAnimationFrame(function () {
      card.querySelectorAll(".fill").forEach(function (f) {
        f.style.width = f.dataset.w + "%";
      });
    });

    while (feed.children.length > MAX_CARDS) feed.removeChild(feed.lastChild);
  }

  function renderAction(ev) {
    nact++;
    nactEl.textContent = nact;
    // A failure has to look like a failure. Colouring is driven by whether the call
    // succeeded AND verified, never by the verified field alone: a refused write has
    // verified === null, and painting that green would be precisely the lie this tool
    // exists to avoid.
    var passed = ev.ok === true && ev.verified !== false;
    if (ev.ok === false) nbad++;
    nbadEl.textContent = nbad;

    var label = ev.verified === true ? "verified"
      : ev.verified === false ? "NOT verified"
      : ev.ok === false ? "failed"
      : "no verification";
    var card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="head">' +
        '<span class="goal act ' + (passed ? "ok" : "no") + '">' + esc(ev.tool) + ": " + esc(label) + "</span>" +
        (ev.ref != null ? '<span class="tag">ref ' + ev.ref + "</span>" : "") +
        '<span class="tag ' + (passed ? "good" : "bad") + '">' +
          (ev.ok ? "returned ok" : "returned failure") + "</span>" +
        '<span class="spacer"></span>' +
        '<span class="when">' + ev.elapsedMs + " ms &middot; " + ago(ev.at) + "</span>" +
      "</div>" +
      '<div style="padding:10px 14px">' +
        "<code>" + esc(ev.target) + "</code>" +
        (ev.reason ? '<div class="act no" style="margin-top:6px">' + esc(ev.reason) + "</div>" : "") +
      "</div>";
    feed.insertBefore(card, feed.firstChild);
    while (feed.children.length > MAX_CARDS) feed.removeChild(feed.lastChild);
  }

  var nrankEl = document.getElementById("nrank");
  var nactEl = document.getElementById("nact");
  var nbadEl = document.getElementById("nbad");
  var dot = document.getElementById("dot");
  var conn = document.getElementById("conn");

  var es = new EventSource("/events");
  es.onopen = function () { dot.className = "dot live"; conn.textContent = "live"; };
  es.onerror = function () { dot.className = "dot down"; conn.textContent = "reconnecting"; };
  es.onmessage = function (m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (e) { return; }
    if (ev.kind === "rank") renderRank(ev);
    else if (ev.kind === "action") renderAction(ev);
  };

  // Keep the relative timestamps honest without re-rendering the whole feed.
  setInterval(function () {
    document.querySelectorAll(".when").forEach(function (n) {
      var t = n.dataset.at;
      if (t) n.textContent = n.textContent.replace(/\\b\\d+[smh] ago\\b/, ago(Number(t)));
    });
  }, 5000);
})();
</script>
</body>
</html>`;
