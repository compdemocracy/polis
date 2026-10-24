import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import request from "supertest";
const { cases, fixture } = require("../../../scripts/build-identity-test.cjs");

describe("build version endpoint", () => {
  test.each(cases)("%s build", async (_name, metadata, expected) => {
    const info = fixture(metadata);
    jest.resetModules();
    jest.doMock("../../src/generated/build-info", () => ({ buildInfo: info }));
    const { handleVersion } = require("../../src/routes/version");
    const app = express();
    app.get("/api/v3/version", handleVersion);
    const response = await request(app).get("/api/v3/version").expect(200);
    expect(response.body.version_display).toBe(expected);
    expect(response.body).toEqual(info);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// Use a separate source tree and process: no generated module, no Git, and no
// working-directory dependency. Changing VERSION after import must not change
// the metadata served by the running process.
test("source-only startup reads VERSION once when generated metadata is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "polis-version-"));
  try {
    const route = join(root, "server/src/routes/version.ts");
    mkdirSync(join(root, "server/src/routes"), { recursive: true });
    copyFileSync(resolve(__dirname, "../../src/routes/version.ts"), route);
    writeFileSync(join(root, "VERSION"), "2.40.0\n");
    const child = spawnSync(
      process.execPath,
      [
        "-r",
        require.resolve("ts-node/register/transpile-only"),
        "-e",
        `const { handleVersion } = require(${JSON.stringify(route)});
       require('node:fs').writeFileSync(${JSON.stringify(
         join(root, "VERSION")
       )}, '9.9.9\\n');
       handleVersion(null, {
         setHeader: (name, value) => { if (name !== 'Cache-Control' || value !== 'no-store') throw Error('cache header'); },
         json: value => process.stdout.write(JSON.stringify(value))
       });`,
      ],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          ...process.env,
          TS_NODE_PROJECT: resolve(__dirname, "../../tsconfig.json"),
        },
      }
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      version_base: "2.40.0",
      version_display: "2.40.0+dev.unknown.unknown",
      commit: "unknown",
      distance: null,
      channel: "development",
      source: "unverified-archive",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
