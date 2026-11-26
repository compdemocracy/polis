// The page reports its errors as every client does: the reporter runs inline
// in the head, before the font and the script, so their load failures are
// reported too. It reports as the report client, whose address this page took
// over (the built page is checked in notices.test.mjs, beside the build it
// reads, since the two files would otherwise build into dist/ at once). The
// standalone file asks no host, so it carries no reporter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the build commit is passed only when it is a commit hash", async () => {
  const { clientErrorPrelude } = await import(join(here, "build.mjs"));
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.ok(clientErrorPrelude({ GIT_HASH: hash }).includes(`"build":"${hash}"`));
  assert.ok(!clientErrorPrelude({ GIT_HASH: "unknown" }).includes('"build"'));
});

test("the standalone file carries no reporter", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-map-errors-"));
  try {
    const doc = join(dir, "doc.json");
    writeFileSync(doc, JSON.stringify({ schema: "polis-topic-map/1", levels: [], topics: [], points: { id: [], x: [], y: [], topic: [] } }));
    const out = join(dir, "page.html");
    execFileSync(process.execPath, [join(here, "build.mjs"), "--standalone", doc, out], { cwd: here, stdio: "pipe" });
    const html = readFileSync(out, "utf8");
    assert.ok(!html.includes("PolisClientErrors"));
    assert.ok(!html.includes("{{CLIENT_ERRORS}}"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
