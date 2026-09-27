"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");

test("dispatch validation works without control-checkout dependencies", (t) => {
  const source = path.resolve(__dirname, ".."),
    target = path.resolve(process.env.P027_ACCOUNTING_REPO || source),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "p027-dispatch-tools-")),
    control = path.join(root, "control");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = ".github/workflows/characterization-rerecord.yml";
  // Copy source files, never symlink the control tree: Node resolves real paths.
  const files = [workflow, "ci/p027_rerecord.sh", "ci/p027_rerecord_build.sh"];
  for (const name of fs.readdirSync(
    path.join(source, "server/characterization")
  ))
    if (name.endsWith(".cjs")) files.push("server/characterization/" + name);
  for (const file of files) {
    const dest = path.join(control, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, file), dest);
  }
  // Read the actual literal run block, so adding another self-test to the
  // workflow also exercises it in this dependency-free control checkout.
  const yaml = fs.readFileSync(path.join(control, workflow), "utf8"),
    step = yaml.match(
      /^      - name: Validate the dispatch tools\n([\s\S]*?)(?=^      - |$(?![\s\S]))/m
    );
  assert.ok(step, "dispatch validation step must exist");
  assert.match(step[1], /^        working-directory: control$/m);
  assert.match(step[1], /^          P027_ACCOUNTING_REPO: .*\/target$/m);
  const run = step[1].match(/^        run: \|\n((?:^          .*\n|^\n)+)/m);
  assert.ok(run, "dispatch validation must retain its literal run block");
  const command = run[1].replace(/^          /gm, "");
  assert.match(command, /node --test /);
  const env = {
    ...process.env,
    P027_ACCOUNTING_REPO: target,
    NODE_PATH: "",
    NODE_OPTIONS: "--no-global-search-paths",
  };
  // This is a separate invocation of the workflow, not a test-runner worker.
  delete env.NODE_TEST_CONTEXT;
  const options = {
    cwd: control,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  };
  // Prove neither ancestors nor global modules can mask the original bug.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const { createRequire } = require("node:module");
    const load = createRequire(process.cwd() + "/server/characterization/probe.cjs");
    assert.throws(() => load.resolve("@aws-sdk/client-dynamodb"),
      { code: "MODULE_NOT_FOUND" });
  `,
    ],
    options
  );
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  for (const dir of [
    "node_modules",
    "server/node_modules",
    "server/characterization/node_modules",
  ])
    assert.equal(fs.existsSync(path.join(control, dir)), false);
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", command],
    options
  );
  for (const line of result.stdout.trimEnd().split("\n")) t.diagnostic(line);
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr + result.stdout
  );
  assert.match(result.stdout, /# fail 0\b/);
  assert.match(result.stdout, /# skipped 0\b/);
});
