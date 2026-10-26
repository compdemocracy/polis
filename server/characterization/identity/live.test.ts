import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";

const { cases } = require("./cases.cjs");

// Always exercise the real Node app. Run on the isolated characterization stack;
// a missing stack is a failure, never a reason to silently skip this test.
it("starts Node and compares live identity responses and effects with the committed fixture", async () => {
  expect(process.env.P027_NETWORK_INTERNAL).toBe("1");
  const cwd = path.join(__dirname, "../..");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    TESTING: "false",
    DEV_MODE: "false",
    P027_BASE_URL: "http://localhost:5000",
    P027_CONTROL_URL: "http://localhost:5001",
  };
  const log = fs.openSync("/artifacts/identity-jest-server.log", "w");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ["characterization/identity/entry.cjs"], {
      cwd,
      env,
      stdio: ["ignore", log, log],
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null)
        throw new Error(
          "Node exited before readiness; see identity-jest-server.log"
        );
      try {
        const response = await fetch(env.P027_CONTROL_URL + "/ready", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Startup is polled within the deadline. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(ready).toBe(true);
    execFileSync(process.execPath, ["characterization/cli.cjs", "seed"], {
      cwd,
      env,
      timeout: 60000,
    });
    const installed = await fetch(
      env.P027_CONTROL_URL + "/votes-provider-tokens",
      {
        method: "POST",
        body: fs.readFileSync(
          "/artifacts/identity-provider-tokens.json",
          "utf8"
        ),
        signal: AbortSignal.timeout(10000),
      }
    );
    expect(installed.ok).toBe(true);
    execFileSync(
      process.execPath,
      ["characterization/identity/run.cjs", "/artifacts/identity-jest"],
      {
        cwd,
        env,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    const result = JSON.parse(
      fs.readFileSync("/artifacts/identity-jest/replay.json", "utf8")
    );
    expect(result).toEqual({ cases: cases.length, differences: [] });
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    fs.closeSync(log);
  }
}, 180000);
