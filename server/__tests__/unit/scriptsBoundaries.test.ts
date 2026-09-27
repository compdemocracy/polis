import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { spawnSync } from "node:child_process";

const serverRoot = path.resolve(__dirname, "../..");
const keyScript = fs.readFileSync(
  path.join(serverRoot, "scripts/generate-jwt-keys.js"),
  "utf8"
);
const witness = path.join(serverRoot, "scripts/projection-gate-witness.mjs");
let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "public-script-test-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function generateKeys(cryptoModule: unknown = crypto) {
  // Execute the unmodified script with its own private directory. Suppress its
  // secret-printing console; generated keys never enter logs or repository files.
  vm.runInNewContext(
    keyScript,
    {
      __dirname: path.join(scratch, "scripts"),
      require: (name: string) =>
        name === "crypto" ? cryptoModule : require(name),
      Buffer,
      console: { log: () => undefined },
    },
    { filename: "generate-jwt-keys.js" }
  );
  return {
    privateKey: fs.readFileSync(path.join(scratch, "keys/jwt-private.pem")),
    publicKey: fs.readFileSync(path.join(scratch, "keys/jwt-public.pem")),
  };
}

// The witness CLI, source parser, actual route/serializer bodies and SQL builder
// execute normally in a child. Only the external PG Client is replaced. The
// strict query fixture rejects any SQL outside its read-only public scenario.
const pgHook = `
const fs = require('fs');
const Module = require('module');
const original = Module._load;
const trace = { connected: false, ended: false, queries: [] };
const record = () => fs.writeFileSync(process.env.PUBLIC_TRACE, JSON.stringify(trace));
class Client {
  constructor() { record(); }
  async connect() { trace.connected = true; record(); }
  async end() { trace.ended = true; record(); }
  async query(text, params) {
    trace.queries.push({ text, params }); record();
    if (text.startsWith('BEGIN')) {
      if (process.env.PUBLIC_MODE === 'begin-failure') throw new Error('public begin failure');
      if (text !== 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') throw new Error('unexpected transaction');
      return { rows: [] };
    }
    if (text === 'ROLLBACK') return { rows: [] };
    if (text.startsWith('SELECT zid, zinvite FROM zinvites')) return { rows: [{ zid: 7, zinvite: 'public-conversation' }] };
    if (!text.startsWith('SELECT') || !(/votes_latest_unique|FROM votes/.test(text))) throw new Error('unexpected SQL');
    const row = { zid: 7, pid: 0, tid: 3, vote: -1, weight_x_32767: 32767 };
    if (text.includes('votes_latest_unique')) row.modified = 1000;
    else { row.created = 1000; row.high_priority = false; }
    if (process.env.PUBLIC_MODE === 'projection-drift' && text.includes('*')) row.public_extra = 'unprojected';
    return { rows: [row] };
  }
}
Module._load = function(name, parent, main) {
  return name === 'pg' ? { Client } : original.call(this, name, parent, main);
};
`;

function runWitness(args: string[], mode = "ordinary") {
  const hook = path.join(scratch, "pg-hook.cjs");
  const tracePath = path.join(scratch, "trace.json");
  fs.writeFileSync(hook, pgHook);
  const result = spawnSync(
    process.execPath,
    ["--require", hook, witness, ...args],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        NODE_PATH: require
          .resolve("typescript/package.json")
          .replace(/\/typescript\/package\.json$/, ""),
        PUBLIC_TRACE: tracePath,
        PUBLIC_MODE: mode,
      },
    }
  );
  if (result.error) throw result.error;
  return {
    ...result,
    trace: fs.existsSync(tracePath)
      ? JSON.parse(fs.readFileSync(tracePath, "utf8"))
      : null,
  };
}
const publicArgs = [
  "--dsn",
  "postgresql://public.invalid/public",
  "--zid",
  "7",
  "--pid",
  "0",
  "--tid",
  "3",
];

test("key generator creates parseable RSA 2048 private and public PEM files", () => {
  const keys = generateKeys();
  const privateKey = crypto.createPrivateKey(keys.privateKey);
  const publicKey = crypto.createPublicKey(keys.publicKey);
  expect(privateKey.asymmetricKeyType).toBe("rsa");
  expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(keys.privateKey.toString()).toContain("BEGIN PRIVATE KEY");
  expect(keys.publicKey.toString()).toContain("BEGIN PUBLIC KEY");
});

test("generated pair signs and verifies a public payload and rejects altered bytes", () => {
  const keys = generateKeys();
  const payload = Buffer.from("public signing fixture");
  const signature = crypto.sign("sha256", payload, keys.privateKey);
  expect(crypto.verify("sha256", payload, keys.publicKey, signature)).toBe(
    true
  );
  expect(
    crypto.verify(
      "sha256",
      Buffer.from("changed public fixture"),
      keys.publicKey,
      signature
    )
  ).toBe(false);
});

test("existing output directory preserves unrelated files while key files are regenerated", () => {
  const first = generateKeys();
  const marker = path.join(scratch, "keys/public-marker.txt");
  fs.writeFileSync(marker, "retain");
  const second = generateKeys();
  expect(second.publicKey.equals(first.publicKey)).toBe(false);
  expect(fs.readFileSync(marker, "utf8")).toBe("retain");
});

test("key generation failure cannot write either key file", () => {
  expect(() =>
    generateKeys({
      generateKeyPairSync: () => {
        throw new Error("public generation failure");
      },
    })
  ).toThrow("public generation failure");
  expect(fs.existsSync(path.join(scratch, "keys/jwt-private.pem"))).toBe(false);
  expect(fs.existsSync(path.join(scratch, "keys/jwt-public.pem"))).toBe(false);
});

test("witness rejects missing or malformed required arguments before opening PG", () => {
  for (const args of [
    [],
    ["--dsn", "postgresql://public.invalid/public", "--zid", "invalid"],
  ]) {
    const result = runWitness(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: --dsn");
    expect(result.stdout).toBe("");
    expect(result.trace).toBeNull();
  }
});

test("witness runs actual source with participant zero and closes each read-only transaction", () => {
  const result = runWitness(publicArgs);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  for (const site of ["votesGet", "handle_GET_votes_me"]) {
    expect(output[site].servedStatus).toBe(200);
    expect(output[site].servedJson).toBe(output[site].expectedJson);
    expect(output[site].served[0].pid).toBe(0);
    expect(output[site].served[0].conversation_id).toBe("public-conversation");
    expect(output[site].served[0]).not.toHaveProperty("zid");
  }
  expect(output.votesGet.servedSql).toMatch(/"pid" = 0/);
  expect(output.votesGet.servedSql).toMatch(/"tid" = 3/);
  expect(
    result.trace.queries.filter((q: { text: string }) =>
      q.text.startsWith("BEGIN")
    )
  ).toHaveLength(2);
  expect(
    result.trace.queries.filter((q: { text: string }) => q.text === "ROLLBACK")
  ).toHaveLength(2);
  expect(result.trace.ended).toBe(true);
});

test("missing participant gates votesGet without any vote SELECT", () => {
  const result = runWitness([
    "--dsn",
    "postgresql://public.invalid/public",
    "--zid",
    "7",
    "--sites",
    "votesGet",
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout).votesGet;
  expect(output.served).toEqual([]);
  expect(output.expected).toEqual([]);
  expect(output.servedSql).toBeNull();
  expect(result.trace.queries.map((q: { text: string }) => q.text)).toEqual([
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "ROLLBACK",
  ]);
  expect(result.trace.ended).toBe(true);
});

test("unknown capture site rolls back, ends the client and emits no success document", () => {
  const result = runWitness([...publicArgs, "--sites", "public-unknown-site"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unknown site: public-unknown-site");
  expect(result.stdout).toBe("");
  expect(result.trace.queries.at(-1).text).toBe("ROLLBACK");
  expect(result.trace.ended).toBe(true);
});

test("missing source builder refuses before any PG client is created", () => {
  fs.mkdirSync(path.join(scratch, "source/db"), { recursive: true });
  fs.writeFileSync(
    path.join(scratch, "source/db/sql.ts"),
    "const unrelated = 1;"
  );
  const result = runWitness([
    ...publicArgs,
    "--src-root",
    path.join(scratch, "source"),
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("variable sql_votes_latest_unique not found");
  expect(result.trace).toBeNull();
});

test("witness preserves extra served columns as a visible mismatch against frozen projection", () => {
  const result = runWitness(
    [...publicArgs, "--sites", "votesGet"],
    "projection-drift"
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout).votesGet;
  expect(output.served[0].public_extra).toBe("unprojected");
  expect(output.expected[0]).not.toHaveProperty("public_extra");
  expect(output.servedJson).not.toBe(output.expectedJson);
  expect(result.trace.ended).toBe(true);
});

test("transaction-start failure still ends its client without a success document", () => {
  const result = runWitness(publicArgs, "begin-failure");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("public begin failure");
  expect(result.stdout).toBe("");
  expect(result.trace.queries).toHaveLength(1);
  expect(result.trace.ended).toBe(true);
});
