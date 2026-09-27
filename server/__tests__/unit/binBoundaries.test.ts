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
const publicArgUrl = "postgresql://public:other-fixture@other.invalid/public";

function migrationFixture(files: Record<string, string> = {}) {
  const script = path.join(scratch, "server/bin/run-migrations.sh");
  const migrations = path.join(scratch, "server/postgres/migrations");
  const fakeBin = path.join(scratch, "fake-bin");
  const trace = path.join(scratch, "calls.jsonl");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(migrations, { recursive: true });
  fs.mkdirSync(fakeBin);
  // Byte-identical script relocated so it can see only public SQL fixtures.
  fs.copyFileSync(path.join(serverRoot, "bin/run-migrations.sh"), script);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(migrations, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const fakePsql = path.join(fakeBin, "psql");
  fs.writeFileSync(
    fakePsql,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const [dsn, flag, file, extra] = process.argv.slice(2);
const allowed = ${JSON.stringify([publicEnvUrl, publicArgUrl])};
if (!allowed.includes(dsn) || flag !== '-f' || extra || !file ||
    path.dirname(file) !== process.env.PUBLIC_MIGRATIONS) {
  throw new Error('not an admitted public invocation');
}
const contents = fs.readFileSync(file, 'utf8');
if (!contents.startsWith('-- public fixture')) throw new Error('not public fixture SQL');
fs.appendFileSync(process.env.PUBLIC_TRACE, JSON.stringify({
  dsn, file: path.basename(file), password: process.env.PGPASSWORD, contents
}) + '\\n');
process.exit(path.basename(file) === process.env.PUBLIC_FAIL ? 17 : 0);
`
  );
  fs.chmodSync(fakePsql, 0o700);
  return {
    run(args: string[] = [], envUrl?: string, fail = "") {
      const result = spawnSync("/bin/bash", [script, ...args], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          PUBLIC_MIGRATIONS: migrations,
          PUBLIC_TRACE: trace,
          PUBLIC_FAIL: fail,
          ...(envUrl === undefined ? {} : { DATABASE_URL: envUrl }),
        },
      });
      if (result.error) throw result.error;
      const calls = fs.existsSync(trace)
        ? fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      return { ...result, calls };
    },
  };
}

const publicSql = "-- public fixture\nSELECT 'public value';\n";

test("migration runner requires a URL before invoking any psql process", () => {
  const result = migrationFixture({ "001.sql": publicSql }).run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("DATABASE_URL is not set");
  expect(result.stdout).not.toContain("All migrations completed successfully");
  expect(result.calls).toEqual([]);
});

test("migration runner sorts top-level SQL and ignores nested SQL and other extensions", () => {
  const result = migrationFixture({
    "010-last.sql": publicSql,
    "002-first.sql": publicSql,
    "nested/001-ignored.sql": publicSql,
    "003-ignored.txt": "not SQL",
  }).run([], publicEnvUrl);
  expect(result.status).toBe(0);
  expect(result.calls.map((call) => call.file)).toEqual([
    "002-first.sql",
    "010-last.sql",
  ]);
  for (const call of result.calls) {
    expect(call.dsn).toBe(publicEnvUrl);
    expect(call.password).toBe("public-fixture");
    expect(call.contents).toBe(publicSql);
  }
  expect(result.stdout).toContain("All migrations completed successfully!");
});

test("explicit migration URL overrides the environment and binds matching password", () => {
  const result = migrationFixture({ "001.sql": publicSql }).run(
    [publicArgUrl],
    publicEnvUrl
  );
  expect(result.status).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].dsn).toBe(publicArgUrl);
  expect(result.calls[0].password).toBe("other-fixture");
});

test("empty explicit URL preserves the environment URL", () => {
  const result = migrationFixture({ "001.sql": publicSql }).run(
    [""],
    publicEnvUrl
  );
  expect(result.status).toBe(0);
  expect(result.calls[0].dsn).toBe(publicEnvUrl);
});

test("psql failure stops later migrations and cannot print completion", () => {
  const result = migrationFixture({
    "001.sql": publicSql,
    "002.sql": publicSql,
    "003.sql": publicSql,
  }).run([], publicEnvUrl, "002.sql");
  expect(result.status).toBe(17);
  expect(result.calls.map((call) => call.file)).toEqual(["001.sql", "002.sql"]);
  expect(result.stdout).not.toContain("Applying migration: 003.sql");
  expect(result.stdout).not.toContain("All migrations completed successfully");
});

test("empty migration directory completes without inventing a database call", () => {
  const result = migrationFixture().run([], publicEnvUrl);
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.stdout).toContain("All migrations completed successfully!");
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
