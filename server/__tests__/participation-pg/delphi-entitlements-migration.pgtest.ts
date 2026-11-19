/** Migration 000048 (the Polis 2 permission table) at deploy, through the real
 * migration runner and the server's own participation code.
 *
 * The table's two foreign keys to users take SHARE ROW EXCLUSIVE on users.
 * While the migration WAITS for that lock, behind a transaction already
 * writing users, every new writer of users queues behind it: a new anonymous
 * participant's account (createAnonUser in auth/create-user.ts, from
 * auth/ensure-participant.ts) and a signed-in account's first request
 * (getOrCreateUserIDFromOidcSub, in a transaction that gives up on a lock
 * after 500 ms: TRANSACTION_SESSION_POLICY in db/pg-query.ts). That request
 * can be a vote. Each waiting request holds a participation connection, so a
 * vote by an existing participant can wait for a connection too.
 *
 *   - Control: without the file's own lock bound (the runner's 5 s), a
 *     signed-in account's first vote sent while the migration waits is
 *     answered HTTP 500 and not recorded.
 *   - The file as released (200 ms): the same requests, sent the same way,
 *     are all answered and recorded; the migration fails with nothing changed
 *     (no table, no history row); once the transaction has ended, the next
 *     deploy applies it.
 *   - Its down, under the same bound, gives up with nothing changed while a
 *     transaction reads users, delays a new participant's account by at most
 *     that bound, and drops the empty table once it can.
 *
 * Each vote runs the middleware of POST /api/v3/votes (app.ts) in order:
 * onParticipationPools, the token step, ensureParticipant and
 * handle_POST_votes. The parameter steps are replaced by the values they
 * assign. A signed-in account's token is the one step not run: express-jwt
 * needs the identity provider's keys, so the payload it would attach is
 * attached and extractUserFromJWT (the step hybridAuthOptional runs after it)
 * runs as it does in production.
 *
 * The participation pools are sized as on a web box with a read replica (3
 * connections each). The database is one of its own on the server
 * DATABASE_URL names, dropped afterwards. The runner is the one
 * scripts/test-delphi-result-reads.sh builds (POLIS_MIGRATE_BIN overrides).
 * Generated data only. */
import { Client } from "pg";
import { execFile, execFileSync } from "child_process";
import { generateKeyPairSync } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { WIRE_AGREE, wireToStorage } from "../../src/votes/convention";

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "server/postgres/migrations");
const RUNNER =
  process.env.POLIS_MIGRATE_BIN ||
  path.join(ROOT, "queue-rs/target/debug/polis-migrate");
const NAME = "000048_create_delphi_entitlements.sql";
const DOWN = path.join(MIGRATIONS, "down/000048_drop_delphi_entitlements.sql");
const DB = "m000048_lock";
const CONVERSATION = "m000048generated";
const ADMIN_URL = process.env.DATABASE_URL as string;
// A web box with a read replica: PARTICIPATION_POOL_MAX and
// PARTICIPATION_READ_POOL_MAX default to 3 there (db/pg-query.ts).
const POOL = 3;
// The file's own bound: the one line that sets it.
const LOCK_BOUND = /^SET LOCAL lock_timeout='[^']*';\n/gm;
// Writers of users that queue behind the waiting migration: one signed-in
// first vote and two anonymous first votes, as many as the pool has
// connections, so the existing participant's vote must wait for one.
const NEW_ACCOUNTS = POOL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Answer = {
  status: number;
  body: any;
  ms: number;
  token?: string;
  uid?: number;
  pid?: number;
};
type Step = (req: any, res: any, next: (err?: any) => void) => unknown;

let admin: Client;
let db: Client;
let before000048: string;
let through000048: string;
let withoutBound: string;
let server: any;
let zid: number;
let usersOid: number;
let databaseOid: number;
let tids: number[] = [];
let existing: Answer;
let accounts = 0;

function url(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The runner's stdout; a refusal throws with its stderr. The DSN goes in the
 * environment, never in argv. */
function runner(command: string, dir: string): string {
  return execFileSync(RUNNER, [command, "--dir", dir], {
    env: { ...process.env, DATABASE_URL: url(DB) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The runner, without waiting for it: its exit code and output. */
function runnerAsync(
  command: string,
  dir: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      RUNNER,
      [command, "--dir", dir],
      { env: { ...process.env, DATABASE_URL: url(DB) }, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        })
    );
  });
}

/** This release with only the numbered migrations `keep` accepts: their
 * files and their release.txt and compat.txt lines. */
function releaseWith(keep: (name: string) => boolean): string {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "release-")),
    "migrations"
  );
  fs.cpSync(MIGRATIONS, dir, { recursive: true });
  const numbered = (name: string) => /^\d{6}_.*\.sql$/.test(name);
  for (const name of fs.readdirSync(dir))
    if (numbered(name) && !keep(name)) fs.rmSync(path.join(dir, name));
  for (const manifest of ["release.txt", "compat.txt"]) {
    const file = path.join(dir, manifest);
    const kept = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        const name = line.split(" ")[0];
        return !numbered(name) || keep(name);
      });
    fs.writeFileSync(file, kept.join("\n"));
  }
  return dir;
}

/** A copy of `release` whose 000048 has no lock bound of its own, so the
 * runner's (5 s) applies. */
function releaseWithoutBound(release: string): string {
  const copy = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "release-")),
    "migrations"
  );
  fs.cpSync(release, copy, { recursive: true });
  const file = path.join(copy, NAME);
  const sql = fs.readFileSync(file, "utf8");
  expect(sql.match(LOCK_BOUND)).toHaveLength(1);
  fs.writeFileSync(file, sql.replace(LOCK_BOUND, ""));
  return copy;
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: url(DB) });
  await client.connect();
  return client;
}

/** The server's modules, on this database, with the pools of a box with a
 * read replica and a generated participant signing key. */
function loadServer() {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  Object.assign(process.env, {
    DATABASE_URL: url(DB),
    PARTICIPATION_POOL_MAX: String(POOL),
    PARTICIPATION_READ_POOL_MAX: String(POOL),
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
    JWKS_URI: "https://identity.example.invalid/.well-known/jwks.json",
    AUTH_ISSUER: "https://identity.example.invalid/",
    AUTH_AUDIENCE: "generated-audience",
  });
  delete process.env.READ_ONLY_DATABASE_URL;
  return {
    scope: require("../../src/db/participation-scope"),
    jwt: require("../../src/auth/jwt-middleware"),
    hybrid: require("../../src/auth/hybrid-jwt"),
    ensure: require("../../src/auth/ensure-participant"),
    votes: require("../../src/routes/votes"),
    parameter: require("../../src/utils/parameter"),
    createUser: require("../../src/auth/create-user"),
  };
}

/** Runs Express middleware in order on a request; resolves with the answer.
 * A step that calls next(err) is answered 500, as Express's error handler
 * does. */
function run(steps: Step[], req: any): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve) => {
    let answered = false;
    const answer = (status: number, body: any) => {
      if (answered) return;
      answered = true;
      resolve({
        status,
        body,
        ms: Date.now() - started,
        token: req.p?.authToken?.token,
        uid: req.p?.uid,
        pid: req.p?.pid,
      });
    };
    const res: any = { statusCode: 200 };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body: any) => {
      answer(res.statusCode, body);
      return res;
    };
    res.set = res.setHeader = () => res;
    let i = 0;
    const next = (err?: any) => {
      if (err) return answer(500, { error: String(err?.message ?? err) });
      const step = steps[i++];
      if (!step) return answer(0, null);
      try {
        Promise.resolve(step(req, res, next)).catch(next);
      } catch (e) {
        next(e);
      }
    };
    next();
  });
}

/** POST /api/v3/votes (app.ts), agreeing with `tid`: anonymous with no
 * identity, an existing participant with its token, or a signed-in account
 * with the payload its verified token carries. */
function vote(
  tid: number,
  identity: { token?: string; account?: Record<string, unknown> } = {}
): Promise<Answer> {
  const { assignToP } = server.parameter;
  const req = {
    p: {},
    headers: identity.token
      ? { authorization: `Bearer ${identity.token}` }
      : {},
    body: { conversation_id: CONVERSATION },
    query: {},
  };
  const token: Step = identity.account
    ? (rq, rs, next) => {
        rq.jwtPayload = identity.account;
        return server.jwt.extractUserFromJWT(assignToP)(rq, rs, next);
      }
    : server.hybrid.hybridAuthOptional(assignToP);
  return run(
    [
      server.scope.onParticipationPools,
      token,
      // need("conversation_id", getConversationIdFetchZid, assignToPCustom("zid"))
      (rq, _rs, next) => {
        assignToP(rq, "zid", zid);
        next();
      },
      server.ensure.ensureParticipant({
        createIfMissing: true,
        issueJWT: true,
      }),
      // need("tid"), need("vote"), want("high_priority", ..., false)
      (rq, _rs, next) => {
        assignToP(rq, "tid", tid);
        assignToP(rq, "vote", WIRE_AGREE);
        assignToP(rq, "high_priority", false);
        next();
      },
      server.votes.handle_POST_votes,
    ],
    req
  );
}

/** A signed-in account that has never been seen: its first request creates
 * its users row. */
function newAccount(): Record<string, unknown> {
  accounts++;
  return {
    sub: `generated|first-${accounts}`,
    email: `first-${accounts}@example.invalid`,
    name: `generated account ${accounts}`,
    email_verified: true,
  };
}

/** The runner's lock request on users, not yet granted. */
async function migrationWaiting(): Promise<boolean> {
  const rows = (
    await admin.query(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.datname = $1 AND a.application_name = 'polis-migrate'
       AND NOT l.granted AND l.database = $2 AND l.relation = $3`,
      [DB, databaseOid, usersOid]
    )
  ).rows;
  return rows.length > 0;
}

/** Other sessions waiting to write users. */
async function usersWritersWaiting(): Promise<number> {
  return (
    await admin.query(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.datname = $1 AND a.application_name <> 'polis-migrate'
       AND NOT l.granted AND l.mode = 'RowExclusiveLock'
       AND l.database = $2 AND l.relation = $3`,
      [DB, databaseOid, usersOid]
    )
  ).rows[0].n;
}

async function untilTrue(
  check: () => Promise<boolean>,
  capMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(what);
    await sleep(2);
  }
}

async function tableExists(): Promise<boolean> {
  return (
    await db.query(
      "SELECT to_regclass('public.delphi_entitlements') IS NOT NULL AS present"
    )
  ).rows[0].present;
}

async function historyRows(): Promise<number> {
  return (
    await db.query(
      "SELECT count(*)::int AS n FROM migrations WHERE name = $1",
      [NAME]
    )
  ).rows[0].n;
}

/** The vote stored for (pid, tid), in storage. */
async function storedVote(pid: number, tid: number): Promise<number | null> {
  const rows = (
    await db.query(
      "SELECT vote FROM votes WHERE zid = $1 AND pid = $2 AND tid = $3",
      [zid, pid, tid]
    )
  ).rows;
  return rows.length === 1 ? rows[0].vote : null;
}

type Contended = {
  exit: number;
  error: string;
  migration_ms: number;
  queued: number;
  migration_waiting_when_existing_sent: boolean;
  signed_in: Answer;
  account: Record<string, unknown>;
  anonymous: Answer[];
  existing: Answer;
};

/** An open transaction writing users; the deploy starts and waits on it; a
 * signed-in account's first vote and anonymous first votes are sent while it
 * waits and, once they queue behind it, an existing participant's vote. */
async function contended(
  label: string,
  release: string,
  firstTid: number,
  existingTid: number
): Promise<Contended> {
  const holder = await connect();
  try {
    await holder.query("BEGIN");
    await holder.query("INSERT INTO users (created) VALUES (default)");
    const started = Date.now();
    const deploying = runnerAsync("deploy", release);
    await untilTrue(
      migrationWaiting,
      10000,
      "the migration never waited on users"
    );
    const account = newAccount();
    const signedIn = vote(firstTid, { account });
    const anonymous = Array.from({ length: NEW_ACCOUNTS - 1 }, () =>
      vote(firstTid)
    );
    let queued = 0;
    let waiting = true;
    const deadline = Date.now() + 4000;
    for (;;) {
      queued = await usersWritersWaiting();
      waiting = await migrationWaiting();
      if (queued >= NEW_ACCOUNTS || !waiting || Date.now() > deadline) break;
      await sleep(2);
    }
    const existingVote = vote(existingTid, { token: existing.token });
    const answers = await Promise.all([signedIn, ...anonymous, existingVote]);
    const deployed = await deploying;
    const migrationMs = Date.now() - started;
    await holder.query("COMMIT");
    const result: Contended = {
      exit: deployed.code,
      error: deployed.stderr.trim().split("\n").pop() || "",
      migration_ms: migrationMs,
      queued,
      migration_waiting_when_existing_sent: waiting,
      signed_in: answers[0],
      account,
      anonymous: answers.slice(1, NEW_ACCOUNTS),
      existing: answers[NEW_ACCOUNTS],
    };
    process.stdout.write(
      `${JSON.stringify({
        scenario: label,
        migration_exit: result.exit,
        migration_error: result.error,
        migration_ms: result.migration_ms,
        users_writers_queued: result.queued,
        migration_waiting_when_existing_sent: waiting,
        signed_in_first_vote: [result.signed_in.status, result.signed_in.ms],
        anonymous_first_votes: result.anonymous.map((a) => [a.status, a.ms]),
        existing_participant_vote: [result.existing.status, result.existing.ms],
      })}\n`
    );
    return result;
  } finally {
    await holder.end().catch(() => undefined);
  }
}

async function mapped(account: Record<string, unknown>): Promise<number> {
  return (
    await db.query(
      `SELECT count(*)::int AS n FROM oidc_user_mappings m JOIN users u ON u.uid = m.uid
       WHERE m.oidc_sub = $1 AND u.email = $2`,
      [account.sub, account.email]
    )
  ).rows[0].n;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  before000048 = releaseWith((name) => name < NAME);
  through000048 = releaseWith((name) => name <= NAME);
  withoutBound = releaseWithoutBound(through000048);
  await admin.query(`CREATE DATABASE ${DB}`);
  runner("deploy", before000048);
  db = await connect();
  usersOid = (await db.query("SELECT 'public.users'::regclass::oid AS oid"))
    .rows[0].oid;
  databaseOid = (
    await admin.query("SELECT oid FROM pg_database WHERE datname = $1", [DB])
  ).rows[0].oid;

  const owner = (
    await db.query(
      "INSERT INTO users (hname, email, created) VALUES ('generated owner', 'owner@example.invalid', default) RETURNING uid"
    )
  ).rows[0].uid;
  zid = (
    await db.query(
      "INSERT INTO conversations (owner, topic, is_active) VALUES ($1, 'generated', true) RETURNING zid",
      [owner]
    )
  ).rows[0].zid;
  await db.query("INSERT INTO zinvites (zid, zinvite) VALUES ($1, $2)", [
    zid,
    CONVERSATION,
  ]);
  const ownerPid = (
    await db.query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
      [zid, owner]
    )
  ).rows[0].pid;
  for (let i = 0; i < 6; i++) {
    tids.push(
      (
        await db.query(
          "INSERT INTO comments (tid, zid, pid, uid, txt) VALUES (NULL, $1, $2, $3, $4) RETURNING tid",
          [zid, ownerPid, owner, `generated statement ${i}`]
        )
      ).rows[0].tid
    );
  }

  server = loadServer();
  // The existing participant: an anonymous first vote before the deploy,
  // which leaves it with a participant token.
  existing = await vote(tids[0]);
  expect(existing.status).toBe(200);
  expect(existing.token).toBeTruthy();
}, 180000);

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin?.end();
  for (const release of [before000048, through000048, withoutBound])
    if (release)
      fs.rmSync(path.dirname(release), { recursive: true, force: true });
});

describe("migration 000048 at deploy, beside an open transaction writing users", () => {
  test("control: without the file's own lock bound (the runner's 5 s), a signed-in account's first vote sent while it waits is answered 500 and not recorded", async () => {
    const r = await contended(
      "000048 without its own lock bound (control)",
      withoutBound,
      tids[0],
      tids[1]
    );

    expect(r.exit).not.toBe(0);
    // lock_not_available: the lock_timeout expired.
    expect(r.error).toContain("SQLSTATE 55P03");
    expect(r.queued).toBe(NEW_ACCOUNTS);
    expect(r.migration_waiting_when_existing_sent).toBe(true);
    expect(r.migration_ms).toBeGreaterThanOrEqual(5000);
    // The refusal: answered while the migration still waited, by the server's
    // own 500 ms lock bound on a first sign-in.
    expect(r.signed_in.status).toBe(500);
    expect(r.signed_in.body).toMatchObject({ error: "user_creation_failed" });
    expect(r.signed_in.ms).toBeLessThan(5000);
    expect(await mapped(r.account)).toBe(0);
    // Everyone else waited and was answered.
    for (const a of r.anonymous) {
      expect(a.status).toBe(200);
      expect(await storedVote(a.pid as number, tids[0])).toBe(
        wireToStorage(WIRE_AGREE)
      );
    }
    expect(r.existing.status).toBe(200);
    expect(await storedVote(existing.pid as number, tids[1])).toBe(
      wireToStorage(WIRE_AGREE)
    );
    expect(await tableExists()).toBe(false);
    expect(await historyRows()).toBe(0);
  }, 120000);

  test("as released (200 ms): every vote is answered and recorded, the migration fails with nothing changed, and the next deploy applies it", async () => {
    // The queue must form inside the migration's 200 ms. Up to three tries
    // for a host pause; every try must refuse nobody and change nothing.
    const tries: Contended[] = [];
    for (const existingTid of tids.slice(2, 5)) {
      const r = await contended(
        "000048 as released",
        through000048,
        tids[0],
        existingTid
      );
      tries.push(r);

      // Nobody refused: the signed-in account's first vote first.
      expect(r.signed_in.status).toBe(200);
      expect(await mapped(r.account)).toBe(1);
      expect(await storedVote(r.signed_in.pid as number, tids[0])).toBe(
        wireToStorage(WIRE_AGREE)
      );
      for (const a of r.anonymous) {
        expect(a.status).toBe(200);
        expect(await storedVote(a.pid as number, tids[0])).toBe(
          wireToStorage(WIRE_AGREE)
        );
      }
      expect(r.existing.status).toBe(200);
      expect(await storedVote(existing.pid as number, existingTid)).toBe(
        wireToStorage(WIRE_AGREE)
      );
      // The migration gave up long before the runner's own 5 s, with nothing
      // changed.
      expect(r.exit).not.toBe(0);
      expect(r.error).toContain("SQLSTATE 55P03");
      expect(r.migration_ms).toBeLessThan(4000);
      expect(await tableExists()).toBe(false);
      expect(await historyRows()).toBe(0);
      if (r.queued === NEW_ACCOUNTS && r.migration_waiting_when_existing_sent)
        break;
    }
    const observed = tries.filter(
      (r) => r.queued === NEW_ACCOUNTS && r.migration_waiting_when_existing_sent
    );
    expect(observed.length).toBeGreaterThan(0);
    const longest = Math.max(
      ...observed.flatMap((r) => [
        r.signed_in.ms,
        ...r.anonymous.map((a) => a.ms),
        r.existing.ms,
      ])
    );
    process.stdout.write(
      `${JSON.stringify({
        scenario:
          "000048 as released, beside an open transaction writing users",
        tries: tries.length,
        longest_request_ms: longest,
      })}\n`
    );

    // With the transaction gone, the next deploy applies it.
    const started = Date.now();
    const out = runner("deploy", through000048);
    expect(
      out.split("\n").filter((line) => line.startsWith("APPLIED "))
    ).toEqual([`APPLIED ${NAME}`]);
    expect(runner("check", through000048)).toMatch(
      /^migration check: \d+ ready$/m
    );
    process.stdout.write(
      `${JSON.stringify({
        scenario: "000048 deploy with nothing writing users",
        runner_ms: Date.now() - started,
      })}\n`
    );
    expect(await tableExists()).toBe(true);
    expect(await historyRows()).toBe(1);
  }, 120000);

  test("its down, under the same bound, gives up with nothing changed while a transaction reads users, delays a new participant's account by at most that, and drops the empty table once it can", async () => {
    if (!(await tableExists())) runner("deploy", through000048);
    const holder = await connect();
    const downer = await connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM users");
      const downPid = (await downer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const started = Date.now();
      const down = downer.query(fs.readFileSync(DOWN, "utf8")).then(
        () => null,
        (error) => error
      );
      const downWaiting = async () =>
        (
          await admin.query(
            "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND relation = $2",
            [downPid, usersOid]
          )
        ).rows.length > 0;
      let waited = await downWaiting();
      const deadline = Date.now() + 4000;
      while (!waited && Date.now() < deadline) {
        await sleep(2);
        waited = await downWaiting();
      }
      // A new anonymous participant's account, sent while the down waits.
      const sent = Date.now();
      const account = new Promise<{ uid?: number; error?: any; ms: number }>(
        (resolve) =>
          server.scope.onParticipationPools(null, null, () =>
            server.createUser.createAnonUser().then(
              (uid: number) => resolve({ uid, ms: Date.now() - sent }),
              (error: any) => resolve({ error, ms: Date.now() - sent })
            )
          )
      );
      const refused = await down;
      const downMs = Date.now() - started;
      const created = await account;
      await downer.query("ROLLBACK");
      process.stdout.write(
        `${JSON.stringify({
          scenario: "000048 down beside an open transaction reading users",
          down_waited_on_users: waited,
          down_error: refused?.code,
          down_ms: downMs,
          new_account_sent_meanwhile_ms: created.ms,
          new_account_created: created.uid !== undefined,
        })}\n`
      );

      expect(waited).toBe(true);
      expect(refused?.code).toBe("55P03");
      expect(downMs).toBeLessThan(4000);
      expect(created.error).toBeUndefined();
      expect(created.uid).toBeGreaterThan(0);
      expect(await tableExists()).toBe(true);
      expect(await historyRows()).toBe(1);

      // Once the transaction has ended, the down drops the empty table; the
      // operator removes the history row in the same sitting, and the release
      // applies 000048 again.
      await holder.query("COMMIT");
      await downer.query(fs.readFileSync(DOWN, "utf8"));
      expect(await tableExists()).toBe(false);
      await downer.query("DELETE FROM migrations WHERE name = $1", [NAME]);
      expect(runner("deploy", through000048)).toContain(`APPLIED ${NAME}`);
      expect(await tableExists()).toBe(true);
    } finally {
      await holder.end().catch(() => undefined);
      await downer.end().catch(() => undefined);
    }
  }, 120000);
});
