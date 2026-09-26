/**
 * Checks that every image and relative link in the docs resolves.
 *
 * A broken image in a README is invisible until someone clicks through it on GitHub,
 * and a diagram that renders as a broken box is worse than no diagram. This also
 * catches the case where a generator script writes to a path the README does not use.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "../support/paths.js";

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const docs = markdownFiles(repoRoot).filter((f) => !f.includes(`${join("node_modules", "")}`));

describe("documentation links", () => {
  it("finds the docs to check", () => {
    // A guard on the guard: if the walk ever finds nothing, every test below passes
    // vacuously.
    assert.ok(docs.length >= 5, `expected several markdown files, found ${docs.length}`);
  });

  it("every image reference resolves to a real file", () => {
    for (const file of docs) {
      const body = readFileSync(file, "utf8");
      const dir = dirname(file);
      // ![alt](path "title")
      for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
        const target = m[1]!;
        if (/^https?:/.test(target)) continue;
        const resolved = resolve(dir, target);
        assert.ok(
          existsSync(resolved),
          `${file.replace(repoRoot + "/", "")} references a missing image: ${target}`,
        );
        assert.ok(
          statSync(resolved).size > 0,
          `${file.replace(repoRoot + "/", "")} references an empty image: ${target}`,
        );
      }
    }
  });

  it("every relative markdown link resolves", () => {
    for (const file of docs) {
      const body = readFileSync(file, "utf8");
      const dir = dirname(file);
      // [text](path) but not ![alt](path)
      for (const m of body.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        const pathOnly = target.split("#")[0]!;
        if (pathOnly === "") continue;
        assert.ok(
          existsSync(resolve(dir, pathOnly)),
          `${file.replace(repoRoot + "/", "")} links to a missing file: ${target}`,
        );
      }
    }
  });

  it("every in-page anchor has a heading to point at", () => {
    // GitHub turns a heading into an anchor by lowercasing it and replacing spaces
    // with hyphens, dropping punctuation. Keep this in step with that.
    const slug = (heading: string) =>
      heading
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");

    for (const file of docs) {
      const body = readFileSync(file, "utf8");
      const headings = new Set(
        [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)),
      );
      for (const m of body.matchAll(/\]\((#[^)]+)\)/g)) {
        const anchor = m[1]!.slice(1);
        assert.ok(
          headings.has(anchor),
          `${file.replace(repoRoot + "/", "")} links to #${anchor}, which is not a heading in that file`,
        );
      }
    }
  });

  it("cross-file anchors point at a heading that exists in the target", () => {
    for (const file of docs) {
      const body = readFileSync(file, "utf8");
      const dir = dirname(file);
      for (const m of body.matchAll(/\]\((?!https?:|#)([^)\s#]+)#([^)\s]+)\)/g)) {
        const [, target, anchor] = m;
        const targetFile = resolve(dir, target!);
        if (!existsSync(targetFile)) continue; // covered by the previous test
        const targetBody = readFileSync(targetFile, "utf8");
        const headings = new Set(
          [...targetBody.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) =>
            h[1]!
              .toLowerCase()
              .replace(/`/g, "")
              .replace(/[^\w\s-]/g, "")
              .trim()
              .replace(/\s+/g, "-"),
          ),
        );
        assert.ok(
          headings.has(anchor!),
          `${file.replace(repoRoot + "/", "")} links to ${target}#${anchor}, which is not a heading there`,
        );
      }
    }
  });

  it("has a CI badge pointing at a workflow that exists", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.match(
      readme,
      /actions\/workflows\/ci\.yml\/badge\.svg/,
      "the README should carry the CI badge",
    );
    assert.ok(
      existsSync(join(repoRoot, ".github/workflows/ci.yml")),
      "the README advertises a CI badge for a workflow that does not exist",
    );
  });

  it("does not advertise badges for things that do not exist", () => {
    // An npm or coverage badge on an unpublished package is a lie that renders as a
    // broken image. Neither is set up here, so neither should be claimed.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const badgeBlock = readme.slice(0, readme.indexOf("\n\n"));
    assert.ok(
      !/npm\/v\/|npm\/dm\/|shields\.io\/badges\/coverage/.test(badgeBlock),
      "the badge block advertises an npm version or coverage that is not published",
    );
  });

  it("keeps the generated diagrams regenerable from committed sources", () => {
    for (const name of ["hero", "architecture"]) {
      assert.ok(
        existsSync(join(repoRoot, "docs/diagrams", `${name}.dsl`)),
        `docs/diagrams/${name}.dsl is missing, so docs/${name}.png cannot be regenerated`,
      );
    }
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.match(pkg.scripts.diagrams ?? "", /render-diagrams/);
  });
});
