import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as vm from "node:vm";

const serverRoot = path.resolve(__dirname, "../..");
let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "public-bin-test-"));
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const publicEnvUrl = "postgresql://public:public-fixture@public.invalid/public";
// The shell entrypoint delegates policy and SQL execution to polis-migrate.
// Its boundary keeps the DSN in the environment and preserves runner failures;
// real SQL/history/startup refusal is covered in polis-migrate/tests/prove.py.
function migrationFixture() {
  const script = path.join(scratch, "server/bin/run-migrations.sh");
  const migrations = path.join(scratch, "server/postgres/migrations");
  const fakeBin = path.join(scratch, "fake-bin");
  const trace = path.join(scratch, "calls.jsonl");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(migrations, { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.copyFileSync(path.join(serverRoot, "bin/run-migrations.sh"), script);
  const fakeRunner = path.join(fakeBin, "polis-migrate");
  fs.writeFileSync(fakeRunner, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(process.env.PUBLIC_TRACE, JSON.stringify({
  args: process.argv.slice(2), dsn: process.env.DATABASE_URL
}) + '\\n');
process.exit(Number(process.env.PUBLIC_EXIT));
`);
  fs.chmodSync(fakeRunner, 0o700);
  return {
    migrations,
    fakeRunner,
    run(options: { args?: string[]; code?: number; binary?: string; envUrl?: string } = {}) {
      const result = spawnSync("/bin/bash", [script, ...(options.args || [])], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          PUBLIC_TRACE: trace,
          PUBLIC_EXIT: String(options.code || 0),
          DATABASE_URL: options.envUrl ?? publicEnvUrl,
          ...(options.binary ? { POLIS_MIGRATE_BIN: options.binary } : {}),
        },
      });
      if (result.error) throw result.error;
      const calls = fs.existsSync(trace)
        ? fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        : [];
      return { ...result, calls };
    },
  };
}

test("migration wrapper delegates once with the checkout's absolute source directory", () => {
  const fixture = migrationFixture();
  const result = fixture.run();
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([{ args: ["apply", "--dir", fixture.migrations], dsn: publicEnvUrl }]);
});

test("migration wrapper keeps the DSN out of argv and output", () => {
  const result = migrationFixture().run();
  expect(result.status).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].args.join(" ")).not.toContain(publicEnvUrl);
  expect(result.stdout + result.stderr).not.toContain(publicEnvUrl);
});

test("migration wrapper supports an explicitly installed binary path containing spaces", () => {
  const fixture = migrationFixture();
  const binary = path.join(scratch, "installed runner");
  fs.copyFileSync(fixture.fakeRunner, binary);
  const result = fixture.run({ binary });
  expect(result.status).toBe(0);
  expect(result.calls).toHaveLength(1);
});

test("migration wrapper preserves argument boundaries for runner validation", () => {
  const fixture = migrationFixture();
  const result = fixture.run({ args: ["--unknown-option", "value with spaces"], code: 2 });
  expect(result.status).toBe(2);
  expect(result.calls[0].args).toEqual(["apply", "--dir", fixture.migrations, "--unknown-option", "value with spaces"]);
});

test("migration wrapper propagates runner failure without a success message or retry", () => {
  const result = migrationFixture().run({ code: 17 });
  expect(result.status).toBe(17);
  expect(result.calls).toHaveLength(1);
  expect(result.stdout).toBe("");
});

test("missing runner refuses without falling back to untracked SQL", () => {
  const result = migrationFixture().run({ binary: path.join(scratch, "absent") });
  expect(result.status).not.toBe(0); // Bash 3/macOS: 1; Bash 5/Linux: 127.
  expect(result.calls).toEqual([]);
  expect(result.stdout).toBe("");
});

function resetBoundary(databaseUrl: unknown) {
  const ts = require("typescript");
  const source = path.join(serverRoot, "bin/db-reset.js");
  const ast = ts.createSourceFile(
    source,
    fs.readFileSync(source, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const names = ["isSafeDatabase", "parseDatabaseUrl", "resetDatabase"];
  const functions = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
  );
  expect(functions).toHaveLength(3);
  const forbidden = jest.fn(() => {
    throw new Error("external reset operation forbidden");
  });
  const exit = jest.fn((code) => {
    throw new Error(`public exit ${code}`);
  });
  const context: Record<string, any> = {
    databaseUrl,
    skipConfirm: false,
    pg: { Client: forbidden },
    fs: { readdirSync: forbidden },
    execAsync: forbidden,
    setTimeout: forbidden,
    process: { exit },
    console: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
    path,
    __dirname: path.join(scratch, "bin"),
  };
  // Extract exact declarations; never evaluate entrypoint imports, dotenv or
  // top-level reset invocation. Refusal cases below may not reach any I/O.
  vm.runInNewContext(
    functions.map((node) => node.getText(ast)).join("\n"),
    context,
    { filename: source }
  );
  return { context, forbidden, exit };
}

test("retained reset parser separates public connection fields and excludes URL query", () => {
  const { context, forbidden } = resetBoundary(null);
  const parsed = context.parseDatabaseUrl(
    "postgres://public:fixture@public.invalid:55499/public-db?sslmode=require"
  );
  expect({ ...parsed }).toEqual({
    username: "public",
    password: "fixture",
    host: "public.invalid",
    port: "55499",
    database: "public-db",
  });
  expect(forbidden).not.toHaveBeenCalled();
});

test("retained reset parser rejects missing port and unsupported connection scheme", () => {
  const { context, forbidden } = resetBoundary(null);
  for (const value of [
    "postgres://public:fixture@public.invalid/public-db",
    "https://public.invalid/public-db",
  ]) {
    expect(() => context.parseDatabaseUrl(value)).toThrow(
      "Invalid DATABASE_URL format"
    );
  }
  expect(forbidden).not.toHaveBeenCalled();
});

test("retained reset safety predicate distinguishes absent and ordinary public input", () => {
  const { context, forbidden } = resetBoundary(null);
  expect(context.isSafeDatabase(undefined)).toBe(false);
  expect(context.isSafeDatabase("")).toBe(false);
  expect(
    context.isSafeDatabase(
      "postgres://public:fixture@public.invalid:55499/public-db"
    )
  ).toBe(true);
  expect(forbidden).not.toHaveBeenCalled();
});

test("actual reset orchestration refuses production indicators before any external operation", async () => {
  for (const value of [
    "postgres://public:fixture@PROD.invalid:55499/public-db",
    "postgres://public:fixture@public.amazonaws.invalid:55499/public-db",
    "postgres://public:fixture@public.invalid:55499/production",
  ]) {
    const { context, forbidden, exit } = resetBoundary(value);
    await expect(context.resetDatabase()).rejects.toThrow("public exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(forbidden).not.toHaveBeenCalled();
  }
});

test("actual reset orchestration refuses malformed URL before any external operation", async () => {
  const { context, forbidden, exit } = resetBoundary("public-invalid-url");
  await expect(context.resetDatabase()).rejects.toThrow(
    "Invalid DATABASE_URL format"
  );
  expect(forbidden).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});
