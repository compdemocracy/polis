import { readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";

/**
 * Anthropic model ids that are retired and return HTTP 404 from the Models API.
 * The report client posts a `model` to the delphi pipeline endpoints, so a
 * retired id here propagates a dead model server-side and breaks report
 * generation. Verified retired (404) against the live Models API on 2026-07-04;
 * the live Opus-tier replacement is `claude-opus-4-8`.
 */
const RETIRED_MODEL_IDS = [
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-opus-4-20250514",
];

// Resolve against Jest's working directory (the client-report package root)
// instead of __dirname/__filename, which are CommonJS-only globals and are
// rejected by this project's ESM eslint config (sourceType: module).
const SRC_DIR = resolve("src");
const GUARD_FILENAME = "no-retired-model-ids.test.js";
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build"]);

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

describe("Anthropic model ids", () => {
  it("no client-report source references a retired (HTTP 404) model id", () => {
    const offenders = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      if (basename(file) === GUARD_FILENAME) continue; // this guard names the retired ids on purpose
      const text = readFileSync(file, "utf8");
      for (const modelId of RETIRED_MODEL_IDS) {
        if (text.includes(modelId)) {
          offenders.push(`${file}: ${modelId}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
