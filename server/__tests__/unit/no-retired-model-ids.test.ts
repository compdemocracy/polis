import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Anthropic model ids that are retired and return HTTP 404 from the Models API.
 * Any source that hardcodes one (e.g. as a request default) is broken at
 * runtime the moment that default is used. Verified retired (404) against the
 * live Models API on 2026-07-04; live replacements are `claude-opus-4-8`
 * (Opus tier) and `claude-sonnet-5` (Sonnet tier).
 */
const RETIRED_MODEL_IDS = [
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-opus-4-20250514",
];

const SRC_DIR = join(__dirname, "..", "..", "src");
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build"]);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (/\.(ts|js)$/.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

describe("Anthropic model ids", () => {
  test("no server source references a retired (HTTP 404) model id", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
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
