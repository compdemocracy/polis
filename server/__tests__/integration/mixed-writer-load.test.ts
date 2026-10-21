/**
 * Two independent writers share the migrated database. By default the second
 * writer is another Node process. MIXED_WRITER_BASE_URL replaces only its HTTP
 * destination, so a future Rust handler uses these same requests and assertions.
 * No request is retried or sent to a fallback after a possible mutation.
 *
 * Twelve participants, every request strictly below 5000 ms, and a 10000 ms
 * client give-up boundary: the existing participation guard's unchanged bounds.
 * A failure is a defect report, never an expected failure or a wider budget.
 */
import { fork, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { Server } from "http";
import { AddressInfo } from "net";
import path from "path";
import request from "supertest";
import { Client, PoolClient } from "pg";
import { getApp } from "../app-loader";
import { setupAuthAndConvo } from "../setup/api-test-helpers";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import pg, {
  MAIN_POOL_MAX,
  PARTICIPATION_POOL_MAX,
  PARTICIPATION_READ_POOL_MAX,
  RESULT_SNAPSHOT_POOL_MAX,
  REPORT_EXPORT_POOL_MAX,
  AGENT_EXCHANGE_POOL_MAX,
} from "../../src/db/pg-query";
import {
  semanticToWire,
  semanticToStorage,
  storageToSemantic,
  wireToSemantic,
  Vote,
  StorageConvention,
  currentStorageConvention,
} from "../../src/votes/convention";

const BUDGET_MS = 5000,
  GIVE_UP_MS = 10000,
  PARTICIPANTS = 12;
const observer = require("../setup/mixed-writer-observer.cjs");
let server: Server,
  child: ChildProcess | undefined,
  primary: string,
  secondary: string;
let admin: Client, conversationId: string, zid: number, tids: number[];
let convention: StorageConvention;
let participants: Participant[];
type Participant = { pid: number; uid: number; token: string };
type Outcome = {
  op: string;
  writer: string;
  pid: number;
  tid?: number;
  text?: string;
  ms: number;
  status: number;
  body: any;
  error?: string;
};
const output = (data: Record<string, unknown>) => {
  process.stdout.write(`MIXED_WRITER ${JSON.stringify(data)}\n`);
};
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(
  check: () => Promise<boolean>,
  label: string,
  ms = GIVE_UP_MS
) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() >= deadline)
      throw new Error(`barrier not reached: ${label}`);
    await delay();
  }
}
async function snapshot(label: string) {
  const activity = (
    await admin.query(`SELECT pid,application_name,state,wait_event_type,
    wait_event,pg_blocking_pids(pid) AS blockers,left(query,180) AS query
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)
  ).rows;
  const locks = (
    await admin.query(`SELECT pid,locktype,mode,granted,relation::regclass::text,
    classid,objid FROM pg_locks WHERE pid IN
    (SELECT pid FROM pg_stat_activity WHERE datname=current_database())`)
  ).rows;
  let secondPools: unknown =
    "external writer; inspect application_name and database waits";
  if (child) {
    secondPools = await new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => reject(new Error("second writer snapshot timeout")),
        GIVE_UP_MS
      );
      const receive = (message: any) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        child!.off("message", receive);
        resolve(message);
      };
      child!.on("message", receive);
      child!.send({ op: "snapshot", id });
    });
  }
  const primaryPools = observer.snapshot();
  output({ label, activity, locks, primaryPools, secondPools });
  for (const diagnostics of [primaryPools, secondPools]) {
    if (typeof diagnostics !== "object") continue;
    for (const pool of (diagnostics as any).pools) {
      if (pool.role === "participation")
        expect(pool.max).toBe(PARTICIPATION_POOL_MAX);
      if (pool.role === "participation-read")
        expect(pool.max).toBe(PARTICIPATION_READ_POOL_MAX);
    }
  }
  return activity;
}
async function call(
  url: string,
  p: Participant | undefined,
  op: string,
  payload: any
): Promise<Outcome> {
  const start = performance.now();
  try {
    let sent =
      op === "nextComment" ||
      op === "participationInit" ||
      op === "votes/me" ||
      op === "votesRead"
        ? request(url)
            .get(`/api/v3/${op === "votesRead" ? "votes" : op}`)
            .query(payload)
        : request(url).post(`/api/v3/${op}`).send(payload);
    if (p) sent = sent.set("Authorization", `Bearer ${p.token}`);
    const res = await sent
      .timeout({ response: GIVE_UP_MS, deadline: GIVE_UP_MS })
      .ok(() => true);
    return {
      op,
      writer: url === primary ? "primary" : "secondary",
      pid: p?.pid ?? -1,
      tid: payload.tid,
      text: payload.txt,
      ms: performance.now() - start,
      status: res.status,
      body: res.body,
    };
  } catch (error) {
    return {
      op,
      writer: url === primary ? "primary" : "secondary",
      pid: p?.pid ?? -1,
      tid: payload.tid,
      text: payload.txt,
      ms: performance.now() - start,
      status: 0,
      body: null,
      error: String(error),
    };
  }
}
const vote = (
  url: string,
  p: Participant | undefined,
  tid: number,
  intent: Vote,
  extra = {}
) =>
  call(url, p, "votes", {
    conversation_id: conversationId,
    tid,
    vote: semanticToWire(intent),
    ...extra,
  });
function prompt(outcomes: Outcome[]) {
  // Do not put auth tokens or entire response objects in the evidence log.
  output({
    outcomes: outcomes.map(({ body: _body, ...rest }) => rest),
    p50_ms: percentile(outcomes, 0.5),
    p95_ms: percentile(outcomes, 0.95),
    max_ms: Math.max(...outcomes.map((x) => x.ms)),
  });
  expect(outcomes.map((x) => x.status)).toEqual(outcomes.map(() => 200));
  expect(outcomes.every((x) => x.ms < BUDGET_MS)).toBe(true);
}
function percentile(values: Outcome[], p: number) {
  return values.map((x) => x.ms).sort((a, b) => a - b)[
    Math.ceil(values.length * p) - 1
  ];
}
async function history(p: Participant, tid: number) {
  return (
    await admin.query(
      "SELECT vote,created,weight_x_32767,high_priority FROM votes WHERE zid=$1 AND pid=$2 AND tid=$3",
      [zid, p.pid, tid]
    )
  ).rows;
}
async function latest(p: Participant, tid: number) {
  const rows = (
    await admin.query(
      "SELECT vote,modified,weight_x_32767 FROM votes_latest_unique WHERE zid=$1 AND pid=$2 AND tid=$3",
      [zid, p.pid, tid]
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0];
}
async function enrolled(url: string): Promise<Participant> {
  const first = await vote(url, undefined, tids[0], "pass");
  prompt([first]);
  const token = first.body.auth?.token,
    pid = first.body.currentPid;
  expect(typeof token).toBe("string");
  expect(Number.isInteger(pid)).toBe(true);
  const rows = (
    await admin.query("SELECT uid FROM participants WHERE zid=$1 AND pid=$2", [
      zid,
      pid,
    ])
  ).rows;
  expect(rows).toHaveLength(1);
  return { pid, uid: rows[0].uid, token };
}
async function durable(outcomes: Outcome[], tid: number) {
  for (const out of outcomes.filter((x) => x.op === "comments")) {
    const p = participants.find((p) => p.pid === out.pid)!;
    const rows = (
      await admin.query(
        "SELECT pid,uid,tid FROM comments WHERE zid=$1 AND txt=$2",
        [zid, out.text]
      )
    ).rows;
    expect(rows).toEqual([{ pid: p.pid, uid: p.uid, tid: out.body.tid }]);
  }
  for (const p of participants) {
    expect(await history(p, tid)).toHaveLength(1);
    expect(storageToSemantic((await latest(p, tid)).vote, { convention })).toBe(
      "agree"
    );
    const next = await call(primary, p, "nextComment", {
      conversation_id: conversationId,
      not_voted_by_pid: p.pid,
    });
    expect(next.status).toBe(200);
    if (Number.isInteger(next.body?.tid)) expect(next.body.tid).not.toBe(tid);
  }
}
async function burst(tid: number, split: boolean, reverse = false) {
  const tag = randomUUID();
  return Promise.all(
    participants.flatMap((p, i) => {
      const url =
        split && i < PARTICIPANTS / 2 !== reverse ? secondary : primary;
      return [
        vote(url, p, tid, "agree"),
        call(primary, p, "comments", {
          conversation_id: conversationId,
          txt: `Generated mixed writer statement ${tag} ${i}`,
          vote: semanticToWire("pass"),
        }),
        call(primary, p, "nextComment", {
          conversation_id: conversationId,
          not_voted_by_pid: p.pid,
        }),
      ];
    })
  );
}
async function countersSettled() {
  await until(
    async () =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM participants p
    WHERE zid=$1 AND EXISTS(SELECT 1 FROM votes v WHERE v.zid=p.zid AND v.pid=p.pid) AND last_interaction=0`,
          [zid]
        )
      ).rows[0].n === 0,
    "notification interaction state settled",
    30000
  );
}

beforeAll(async () => {
  admin = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: "mixed-writer-observer",
  });
  await admin.connect();
  // This release's conversion source is constant; it has no database convention
  // table. Fail if a later schema adds one without updating this admission.
  expect(
    (await admin.query("SELECT to_regclass('public.vote_convention') AS name"))
      .rows[0].name
  ).toBeNull();
  convention = currentStorageConvention();
  const app = await getApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  primary = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (process.env.MIXED_WRITER_BASE_URL) {
    const url = new URL(process.env.MIXED_WRITER_BASE_URL);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("second writer must be local");
    secondary = url.origin;
  } else {
    const database = new URL(process.env.DATABASE_URL!);
    database.searchParams.set("application_name", "mixed-writer-secondary");
    child = fork(
      path.resolve(__dirname, "../setup/mixed-writer-process.cjs"),
      [],
      {
        env: {
          ...process.env,
          DATABASE_URL: database.toString(),
          READ_ONLY_DATABASE_URL: database.toString(),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }
    );
    child.stderr?.on("data", (data) => process.stderr.write(data));
    secondary = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("second writer startup timeout")),
        60000
      );
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`second writer exited ${code}`));
      });
      child!.on("message", (message: any) => {
        if (message.ready) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${message.port}`);
        }
      });
    });
  }
  const setup = await setupAuthAndConvo({ commentCount: 16 });
  conversationId = setup.conversationId;
  tids = setup.commentIds;
  zid = (
    await admin.query("SELECT zid FROM zinvites WHERE zinvite=$1", [
      conversationId,
    ])
  ).rows[0].zid;
  // Include pid zero explicitly; the owner's seeded comments enrolled them.
  const owner = (
    await admin.query(
      "SELECT pid,uid FROM participants WHERE zid=$1 ORDER BY pid",
      [zid]
    )
  ).rows;
  expect(owner[0].pid).toBe(0);
  participants = [];
  for (let i = 0; i < PARTICIPANTS; i++)
    participants.push(await enrolled(i % 2 ? primary : secondary));
  const max = Number(
    (await admin.query("SHOW max_connections")).rows[0].max_connections
  );
  const reserved = Number(
    (await admin.query("SHOW superuser_reserved_connections")).rows[0]
      .superuser_reserved_connections
  );
  const perNode =
    2 * MAIN_POOL_MAX +
    PARTICIPATION_POOL_MAX +
    PARTICIPATION_READ_POOL_MAX +
    RESULT_SNAPSHOT_POOL_MAX +
    REPORT_EXPORT_POOL_MAX +
    AGENT_EXCHANGE_POOL_MAX +
    2;
  expect(2 * perNode + 8).toBeLessThanOrEqual(max - reserved);
  output({
    budget_ms: BUDGET_MS,
    give_up_ms: GIVE_UP_MS,
    participants: PARTICIPANTS,
    per_node_pool_max: perNode,
    postgres_max: max,
    administrative_reserve: 8,
    second_writer: child ? "independent Node process" : "external HTTP handler",
    participation_write_max: PARTICIPATION_POOL_MAX,
    participation_read_max: PARTICIPATION_READ_POOL_MAX,
  });
}, 120000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) =>
      child!.once("exit", () => resolve())
    );
    child.send({ op: "stop" });
    const timer = setTimeout(() => child!.kill("SIGTERM"), GIVE_UP_MS);
    await stopped;
    clearTimeout(timer);
  }
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  await admin?.end();
});

test("Node control, split ownership, reversed ownership and Node down phase preserve every write", async () => {
  for (const [index, name] of [
    "node-before",
    "split",
    "split-reversed",
    "node-after",
  ].entries()) {
    const outcomes = await burst(
      tids[index + 1],
      index === 1 || index === 2,
      index === 2
    );
    prompt(outcomes);
    await durable(outcomes, tids[index + 1]);
    await countersSettled();
    await snapshot(name);
  }
}, 120000);

test("same-key concurrent writers append both votes and retain exactly one latest row", async () => {
  const tid = tids[5];
  const outcomes = await Promise.all(
    participants.flatMap((p) => [
      vote(primary, p, tid, "agree"),
      vote(secondary, p, tid, "disagree"),
    ])
  );
  prompt(outcomes);
  for (const p of participants) {
    const rows = await history(p, tid);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => storageToSemantic(row.vote, { convention })).sort()
    ).toEqual(["agree", "disagree"]);
    expect(["agree", "disagree"]).toContain(
      storageToSemantic((await latest(p, tid)).vote, { convention })
    );
  }
  await countersSettled();
});

test("both serialized writer orders and repeat votes preserve history and the last insertion", async () => {
  for (const [i, urls] of [
    [primary, secondary],
    [secondary, primary],
  ].entries()) {
    const p = participants[i],
      tid = tids[6 + i];
    prompt([await vote(urls[0], p, tid, "agree")]);
    prompt([await vote(urls[1], p, tid, "disagree")]);
    prompt([await vote(urls[1], p, tid, "disagree")]);
    expect(await history(p, tid)).toHaveLength(3);
    expect(storageToSemantic((await latest(p, tid)).vote, { convention })).toBe(
      "disagree"
    );
    const readback = await call(primary, p, "votes/me", {
      conversation_id: conversationId,
    });
    expect(readback.status).toBe(200);
    const rows = Array.isArray(readback.body)
      ? readback.body
      : readback.body.votes;
    // votes/me returns history without an ORDER BY, not the latest relation.
    expect(
      rows
        .filter((row: any) => row.tid === tid)
        .map((row: any) => wireToSemantic(row.vote))
        .sort()
    ).toEqual(["agree", "disagree", "disagree"]);
    const latestRead = await call(primary, p, "votesRead", {
      conversation_id: conversationId,
      pid: p.pid,
      tid,
    });
    expect(latestRead.status).toBe(200);
    expect(latestRead.body).toHaveLength(1);
    expect(wireToSemantic(latestRead.body[0].vote)).toBe("disagree");
  }
});

test("equal and decreasing timestamps follow insertion order and retain the original latest weight", async () => {
  const p = participants[0],
    tid = tids[8],
    created = Date.now();
  for (const [index, intent] of (
    ["agree", "disagree", "pass"] as Vote[]
  ).entries()) {
    // The direct database witness still crosses the convention module.
    await admin.query(
      `INSERT INTO votes(zid,pid,tid,vote,created,weight_x_32767,high_priority)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        zid,
        p.pid,
        tid,
        semanticToStorage(intent, { convention }),
        created - (index === 2 ? 1 : 0),
        index === 0 ? 20000 : 10000,
        index === 0,
      ]
    );
    const row = await latest(p, tid);
    expect(storageToSemantic(row.vote, { convention })).toBe(intent);
    expect(Number(row.modified)).toBe(created - (index === 2 ? 1 : 0));
    expect(row.weight_x_32767).toBe(20000);
  }
  expect(await history(p, tid)).toHaveLength(3);
});

test("concurrent first votes through both writers allocate distinct participants without losing a vote", async () => {
  const before = Number(
    (await admin.query("SELECT count(*) FROM participants WHERE zid=$1", [zid]))
      .rows[0].count
  );
  const newParticipants = await Promise.all(
    Array.from({ length: PARTICIPANTS }, (_, i) =>
      enrolled(i % 2 ? primary : secondary)
    )
  );
  expect(new Set(newParticipants.map((p) => p.pid)).size).toBe(PARTICIPANTS);
  expect(new Set(newParticipants.map((p) => p.uid)).size).toBe(PARTICIPANTS);
  expect(
    Number(
      (
        await admin.query("SELECT count(*) FROM participants WHERE zid=$1", [
          zid,
        ])
      ).rows[0].count
    )
  ).toBe(before + PARTICIPANTS);
  for (const p of newParticipants)
    expect(await history(p, tids[0])).toHaveLength(1);
});

test("two first writes for one generated identity allocate one participant and store both votes", async () => {
  // participationInit does not issue an anonymous identity before a first
  // write. Make a generated user and use the real issuer for the join race.
  const uid = (
    await admin.query(
      "INSERT INTO users(hname,email) VALUES($1,$2) RETURNING uid",
      ["Generated shared identity", `${randomUUID()}@example.invalid`]
    )
  ).rows[0].uid;
  const p = { uid, pid: -1, token: issueAnonymousJWT(conversationId, uid, -1) };
  const before = (
    await admin.query("SELECT * FROM participants WHERE zid=$1 AND uid=$2", [
      zid,
      p.uid,
    ])
  ).rows;
  const outcomes = await Promise.all([
    vote(primary, p, tids[12], "agree"),
    vote(secondary, p, tids[13], "disagree"),
  ]);
  prompt(outcomes);
  const rows = (
    await admin.query("SELECT pid FROM participants WHERE zid=$1 AND uid=$2", [
      zid,
      p.uid,
    ])
  ).rows;
  expect(rows).toHaveLength(1);
  expect(outcomes.map((x) => x.body.currentPid)).toEqual([
    rows[0].pid,
    rows[0].pid,
  ]);
  p.pid = rows[0].pid;
  expect(await history(p, tids[12])).toHaveLength(1);
  expect(await history(p, tids[13])).toHaveLength(1);
  output({
    same_identity_memberships_before: before.length,
    same_identity_memberships_after: rows.length,
  });
});

test("pid zero is an admitted durable participant at both writers", async () => {
  const row = (
    await admin.query("SELECT uid FROM participants WHERE zid=$1 AND pid=0", [
      zid,
    ])
  ).rows[0];
  const p = {
    uid: row.uid,
    pid: 0,
    token: issueAnonymousJWT(conversationId, row.uid, 0),
  };
  const comment = await call(primary, participants[0], "comments", {
    conversation_id: conversationId,
    txt: `Generated pid zero target ${randomUUID()}`,
    vote: semanticToWire("pass"),
  });
  prompt([comment]);
  prompt([await vote(primary, p, comment.body.tid, "agree")]);
  prompt([await vote(secondary, p, comment.body.tid, "disagree")]);
  expect(await history(p, comment.body.tid)).toHaveLength(2);
  expect(
    storageToSemantic((await latest(p, comment.body.tid)).vote, { convention })
  ).toBe("disagree");
});

test("a second allocator never loses a first vote across another writer's commit boundary", async () => {
  const writer = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: "mixed-writer-allocator",
  });
  await writer.connect();
  let pending: Promise<Outcome> | undefined;
  try {
    const uid = (
      await admin.query(
        "INSERT INTO users(hname,email) VALUES($1,$2) RETURNING uid",
        ["Generated allocator participant", `${randomUUID()}@example.invalid`]
      )
    ).rows[0].uid;
    await writer.query("BEGIN");
    const inserted = (
      await writer.query(
        "INSERT INTO participants(pid,zid,uid) VALUES(NULL,$1,$2) RETURNING pid",
        [zid, uid]
      )
    ).rows[0];
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    pending = vote(secondary, undefined, tids[15], "agree");
    await until(
      async () =>
        (
          await admin.query(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,
            [writerPid]
          )
        ).rows[0].waiting,
      "second allocator reaches the uncommitted first writer"
    );
    await snapshot("allocator-before-first-commit");
    await writer.query("COMMIT");
    const outcome = await pending;
    output({
      allocator_first_pid: inserted.pid,
      allocator_second_status: outcome.status,
      allocator_second_error: outcome.status === 200 ? null : outcome.body,
    });
    prompt([outcome]);
    expect(outcome.body.currentPid).not.toBe(inserted.pid);
    const stored = (
      await admin.query(
        "SELECT * FROM votes WHERE zid=$1 AND pid=$2 AND tid=$3",
        [zid, outcome.body.currentPid, tids[15]]
      )
    ).rows;
    expect(stored).toHaveLength(1);
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    await writer.end();
    if (pending) await pending;
  }
});

test("omitted, true, false and repeated stars retain separate history and importance", async () => {
  const p = participants[1],
    tid = tids[14];
  prompt([await vote(primary, p, tid, "agree", { high_priority: true })]);
  expect(
    (
      await admin.query(
        "SELECT * FROM stars WHERE zid=$1 AND pid=$2 AND tid=$3",
        [zid, p.pid, tid]
      )
    ).rows
  ).toHaveLength(0);
  for (const starred of [true, false, false])
    prompt([await vote(secondary, p, tid, "agree", { starred })]);
  expect(await history(p, tid)).toHaveLength(4);
  expect(
    (await history(p, tid)).filter((row) => row.high_priority)
  ).toHaveLength(1);
  const stars = (
    await admin.query(
      "SELECT starred FROM stars WHERE zid=$1 AND pid=$2 AND tid=$3",
      [zid, p.pid, tid]
    )
  ).rows;
  expect(stars).toHaveLength(3);
  expect(stars.filter((row) => Boolean(row.starred))).toHaveLength(1);
});

test("mixed writes stay prompt while every slow-work pool is occupied and result work awaits its model", async () => {
  const clients: PoolClient[] = [],
    long: Promise<unknown>[] = [];
  let answer!: () => void;
  const model = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let waiting = 0;
  try {
    await Promise.all(
      Array.from({ length: RESULT_SNAPSHOT_POOL_MAX }, async () => {
        const client = await pg.connectResultSnapshot();
        try {
          await client.query("SELECT 1");
        } finally {
          client.release();
        }
        waiting++;
        long.push(model);
      })
    );
    expect(waiting).toBe(RESULT_SNAPSHOT_POOL_MAX);
    for (const [n, connect] of [
      [MAIN_POOL_MAX, () => pg.connect()],
      [MAIN_POOL_MAX, () => pg.connectReadOnly()],
      [AGENT_EXCHANGE_POOL_MAX, () => pg.connectAgentExchange()],
      [RESULT_SNAPSHOT_POOL_MAX, () => pg.connectResultSnapshot()],
    ] as [number, () => Promise<PoolClient>][]) {
      for (let i = 0; i < n; i++) clients.push(await connect());
    }
    await admin.query("SELECT pg_advisory_lock($1,$2)", [72189, zid]);
    for (let i = 0; i < REPORT_EXPORT_POOL_MAX; i++)
      long.push(
        pg.queryP_reportExport(
          "SELECT pg_advisory_xact_lock_shared($1,$2) /* mixed writer export barrier */",
          [72189, zid]
        )
      );
    await until(
      async () =>
        (
          await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%mixed writer export barrier%'`)
        ).rows[0].n === REPORT_EXPORT_POOL_MAX,
      "all export connections parked"
    );
    const before = await snapshot("slow-work-parked");
    expect(
      before.filter((row) => row.state?.startsWith("idle in transaction"))
    ).toHaveLength(0);
    const outcomes = await burst(tids[9], true);
    expect(waiting).toBe(RESULT_SNAPSHOT_POOL_MAX);
    prompt(outcomes);
    const after = await snapshot("participation-complete-before-release");
    expect(
      after.filter(
        (row) =>
          row.query.includes("mixed writer export barrier") &&
          row.wait_event_type === "Lock"
      )
    ).toHaveLength(REPORT_EXPORT_POOL_MAX);
    await durable(outcomes, tids[9]);
  } finally {
    answer();
    clients.forEach((client) => client.release());
    await admin.query("SELECT pg_advisory_unlock_all()");
    await Promise.allSettled(long);
  }
}, 120000);

test("same-conversation maintenance row locks leave participation responsive", async () => {
  const blocker = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: "mixed-writer-slow-row",
  });
  await blocker.connect();
  let outcomes: Outcome[] = [],
    first: Outcome[] = [];
  try {
    await blocker.query("BEGIN");
    // Model the import batch's conversation participant_count update and the
    // bulk participant statistics update with their non-key row lock mode.
    // These are existing participants. A fresh join updates participant_count
    // through pid_auto; this wave does not qualify fresh joins behind an import.
    await blocker.query(
      "SELECT zid FROM conversations WHERE zid=$1 FOR NO KEY UPDATE",
      [zid]
    );
    const heldParticipants = await blocker.query(
      "SELECT pid FROM participants WHERE zid=$1 AND pid=ANY($2::int[]) FOR NO KEY UPDATE",
      [zid, participants.map((p) => p.pid)]
    );
    expect(heldParticipants.rows).toHaveLength(PARTICIPANTS);
    // Verify the blocker directly: successful isolation removes the old
    // participation-pool waiters, so their existence cannot be a prerequisite.
    // A separate observer attempts the same row locks with NOWAIT below.
    first = await Promise.all(
      participants.map((p, i) =>
        vote(i % 2 ? primary : secondary, p, tids[10], "agree")
      )
    );
    // Keep the first wave's failures too, but collect all three participation
    // operations and lock ownership before asserting or releasing slow work.
    await expect(
      admin.query(
        "SELECT zid FROM conversations WHERE zid=$1 FOR NO KEY UPDATE NOWAIT",
        [zid]
      )
    ).rejects.toMatchObject({ code: "55P03" });
    for (const participant of participants) {
      await expect(
        admin.query(
          "SELECT pid FROM participants WHERE zid=$1 AND pid=$2 FOR NO KEY UPDATE NOWAIT",
          [zid, participant.pid]
        )
      ).rejects.toMatchObject({ code: "55P03" });
    }
    await snapshot("same-row-held-before-participation");
    outcomes = await burst(tids[11], true);
    await snapshot("same-row-held-after-participation");
    prompt(first);
    prompt(outcomes);
    await durable(outcomes, tids[11]);
  } finally {
    // Retain failures before releasing the lock; release cannot turn a timeout
    // into a successful measured request. Inspect ambiguous commits separately.
    output({
      same_row_outcomes_before_release: [...first, ...outcomes].map(
        ({ body: _body, ...rest }) => rest
      ),
    });
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end();
    // The client giving up does not cancel Node's queued work. Keep this
    // generated fixture and the process alive until every attempted mutation
    // is independently visible; otherwise Jest's forceExit could manufacture
    // apparent loss by killing requests during cleanup.
    const texts = outcomes
      .filter((outcome) => outcome.op === "comments")
      .map((outcome) => outcome.text);
    if (first.length === PARTICIPANTS && outcomes.length === PARTICIPANTS * 3) {
      await until(
        async () => {
          const votes = (
            await admin.query(
              `SELECT count(*)::int AS n FROM votes
          WHERE zid=$1 AND tid=ANY($2::int[]) AND pid=ANY($3::int[])`,
              [zid, [tids[10], tids[11]], participants.map((p) => p.pid)]
            )
          ).rows[0].n;
          const comments = (
            await admin.query(
              "SELECT count(*)::int AS n FROM comments WHERE zid=$1 AND txt=ANY($2::text[])",
              [zid, texts]
            )
          ).rows[0].n;
          return votes === PARTICIPANTS * 2 && comments === PARTICIPANTS;
        },
        "queued mutations visible after releasing slow work",
        30000
      );
      const storedCounts = (
        await admin.query("SELECT vote_count FROM participants WHERE zid=$1", [
          zid,
        ])
      ).rows;
      expect(storedCounts.every((p) => p.vote_count === 0)).toBe(true);
      for (const p of participants) {
        for (const tid of [tids[10], tids[11]]) {
          expect(await history(p, tid)).toHaveLength(1);
          expect(
            storageToSemantic((await latest(p, tid)).vote, { convention })
          ).toBe("agree");
        }
      }
      const comments = (
        await admin.query(
          "SELECT pid,uid,tid,txt FROM comments WHERE zid=$1 AND txt=ANY($2::text[])",
          [zid, texts]
        )
      ).rows;
      expect(new Set(comments.map((row) => row.tid)).size).toBe(PARTICIPANTS);
      for (const out of outcomes.filter(
        (outcome) => outcome.op === "comments"
      )) {
        const p = participants.find((p) => p.pid === out.pid)!;
        const rows = comments.filter((row) => row.txt === out.text);
        expect(rows).toHaveLength(1);
        expect(rows[0].pid).toBe(p.pid);
        expect(rows[0].uid).toBe(p.uid);
      }
    }
    await until(
      async () => {
        const activity =
          await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0
        AND (query LIKE 'update participants%' OR query LIKE 'update conversations%')`);
        return activity.rows[0].n === 0;
      },
      "blocked notification work released",
      30000
    );
    output({
      reconciliation_after_release: (
        await admin.query(
          `SELECT pid,tid,count(*)::int AS rows
      FROM votes WHERE zid=$1 AND tid=ANY($2::int[]) GROUP BY pid,tid ORDER BY pid,tid`,
          [zid, [tids[10], tids[11]]]
        )
      ).rows,
      comments_after_release: (
        await admin.query(
          "SELECT pid,uid,tid FROM comments WHERE zid=$1 AND txt=ANY($2::text[]) ORDER BY pid",
          [zid, texts]
        )
      ).rows,
    });
  }
}, 120000);
