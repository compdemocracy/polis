import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

interface BuildInfo {
  version_base: string;
  version_display: string;
  commit: string;
  distance: number | null;
  channel: string;
  source: string;
}

function loadBuildInfo(): BuildInfo {
  let generated: string;
  try {
    generated = require.resolve("../generated/build-info");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // Source-only harnesses do not run prebuild. Read the root version once,
    // without Git or environment overrides, and report unknown provenance.
    // Compiled routes have one extra directory level (server/dist/src/routes).
    const root =
      basename(resolve(__dirname, "../..")) === "dist"
        ? "../../../../VERSION"
        : "../../../VERSION";
    const version = readFileSync(resolve(__dirname, root), "utf8").trim();
    return Object.freeze({
      version_base: version,
      version_display: `${version}+dev.unknown.unknown`,
      commit: "unknown",
      distance: null,
      channel: "development",
      source: "unverified-archive",
    });
  }
  return require(generated).buildInfo;
}

const buildInfo = loadBuildInfo();

export function handleVersion(
  _req: unknown,
  res: {
    setHeader: (name: string, value: string) => unknown;
    json: (value: BuildInfo) => unknown;
  }
) {
  res.setHeader("Cache-Control", "no-store");
  res.json(buildInfo);
}
