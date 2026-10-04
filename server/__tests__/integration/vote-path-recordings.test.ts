import { randomUUID } from "crypto";
import fs from "fs";
import { gunzipSync } from "zlib";
import path from "path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Response } from "supertest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import Config from "../../src/config";
import pgQuery from "../../src/db/pg-query";
import { processImportJob, s3Client } from "../../src/workers/import-processor";
import { sqsClient } from "../../src/utils/sqs";
import http from "http";
import request from "supertest";
import {
  createAppInstance,
  getOidcToken,
  wait,
} from "../setup/api-test-helpers";
import { fromWire, toWire } from "../setup/vote-wire";
import {
  getPooledTestUser,
  RESERVED_POOLED_USER_INDEXES,
} from "../setup/test-user-helpers";
import { pool, closePool } from "../setup/db-test-helpers";
import {
  cleanupDelphiTopicData,
  createDelphiTopicCluster,
} from "../setup/dynamodb-test-helpers";

/**
 * Vote-path recordings: every server path that reads, writes, serves, exports
 * or imports a vote value, driven through the real application and compared
 * byte for byte with what `origin/edge` served for the same requests.
 *
 * This is a characterization, not an opinion. The golden beside this file was
 * RECORDED BY RUNNING THIS FILE ON `origin/edge` (see `RECORD_ENV` below), so
 * every case asserts "identical to what edge serves" -- including behaviour that
 * may look odd (a NULL vote exported as 0, a stored 2 exported as -2, a vote on
 * a moderated-out comment). A difference is a finding to report and rule on,
 * never something to re-record away.
 *
 * What is covered (each name below is one recorded case):
 *
 *   writes   POST /votes agree / disagree / pass, a changed vote
 *            (agree -> disagree -> pass), out-of-range wire values, a vote on a
 *            moderated-out comment, high_priority; POST /comments with each vote
 *            value and the is_seed default; POST /comments-bulk seed votes; the
 *            votes-bulk import worker (export convention, a changed vote,
 *            out-of-range and unparseable values). The stored rows
 *            (`votes`, `votes_latest_unique`) are recorded after each phase.
 *   actors   an anonymous participant, an XID participant, a participant with
 *            no votes, the owner.
 *   reads    GET /votes (by pid, by pid+tid, mypid, no pid), GET /votes/me,
 *            GET /votes/famous, participationInit (votes, famous, nextComment),
 *            GET /nextComment, the moderation comment list with voting
 *            patterns, conversationStats.
 *   exports  every reportExport CSV (summary, comments, votes, participant-votes,
 *            participant-importance, comment-groups, comment-clusters), with and
 *            without importance enabled, and the XID report.
 *   report   the collective-statement topic query (its SQL text and the vote
 *            counts it reads; the model is never called).
 *   edges    an empty conversation, a conversation with comments and no votes,
 *            stored NULL and out-of-range vote values written directly to the
 *            database (the column has no CHECK).
 *
 * Determinism. Every value that differs between runs is replaced lexically and
 * only where it occurs -- the response bytes are otherwise compared exactly,
 * including key order and whitespace:
 *   - the run token in generated XIDs, usernames and topics -> <run>
 *   - conversation_ids, report_ids and the zinvite uuid -> <conv:NAME> etc.
 *   - "zid"/"uid"/"owner"/"org_id"/"site_id" JSON numbers -> <zid#n>/<uid#n>
 *     (numbered by first appearance, so identity across responses is kept)
 *   - epoch milliseconds/seconds, ISO and Date.toString() datetimes -> <ms> etc.
 *   - JWTs -> <jwt>; polis_site_id_... -> <site-id>; epoch microseconds -> <us>
 *   - gzipped JSON inside a serialized Buffer is decoded first ($gunzip)
 *   - four row orders that edge itself does not define are compared as sets
 *     of rows, and participant-votes.csv cells for a changed vote are masked
 *     as <changed-vote> (see UNORDERED: edge returned different orders, and
 *     a different cell value, between two runs)
 *   - supertest's ephemeral http://127.0.0.1:<port> origin -> <local-origin>
 * `getNextComment` draws with Math.random(); it is pinned to 0.5 for the run,
 * so the comment chosen and the `randomN` it reports are part of the recording.
 */

const GOLDEN_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "vote-path-golden.json"
);

/**
 * How the golden was made, and the ONLY way to remake it:
 *
 *  1. Re-record on `origin/edge` itself, in a PR that changes no server code.
 *     CI enforces this: the "vote-path-golden-guard" job of Server Integration
 *     Tests (ci/vote_path_golden_guard.sh) fails any PR that changes this
 *     golden together with server/src, app.ts, index.ts, package*.json or
 *     server/postgres. A branch can therefore never re-record the golden on
 *     its own changed server and pass.
 *  2. Record twice and require the two goldens to be identical:
 *
 *       git worktree add --detach /tmp/edge-tree origin/edge
 *       cp -R server/__tests__ /tmp/edge-tree/server/   (this PR's test files)
 *       cd /tmp/edge-tree/server && npm ci
 *       VOTE_PATH_RECORD_GOLDEN=1 npx jest --ci vote-path-recordings
 *       cp __tests__/fixtures/vote-path-golden.json /tmp/golden-1.json
 *       VOTE_PATH_RECORD_GOLDEN=1 npx jest --ci vote-path-recordings
 *       diff /tmp/golden-1.json __tests__/fixtures/vote-path-golden.json
 *
 *     A case that differs between two edge runs is nondeterministic: fix it
 *     in the named normalization or order exemptions here, never by masking
 *     a whole response.
 *  3. Re-check the mutation list on a tree that has the server's vote
 *     convention module: `node __tests__/mutation/vote-path-mutations.cjs`
 *     (see that file). Every listed sign mutation must still fail exactly its
 *     expected cases; review any change before rewriting it with --record.
 *
 * The committed golden was recorded on origin/edge 962783fc7, twice, with
 * identical results (234 cases).
 *
 * In record mode every comparison returns early; it records, it does not judge.
 */
const RECORD_ENV = "VOTE_PATH_RECORD_GOLDEN";
const RECORDING = process.env[RECORD_ENV] === "1";

type Observation = {
  status: number;
  contentType: string | null;
  text: string;
};

const golden: Record<string, Observation> = RECORDING
  ? {}
  : JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

// A run token that makes every generated identity unique to this run; it is
// normalized away, so it never reaches the comparison.
const RUN = `vpr${Date.now().toString(36)}`;

const observed = new Map<string, Observation>();

class Normalizer {
  private strings: Array<[string, string]> = [[RUN, "<run>"]];
  private numbered = new Map<string, Map<string, string>>();

  /** A server-generated string (conversation_id, report_id, uuid). */
  name(value: string | number | null | undefined, symbol: string) {
    if (value === null || value === undefined || value === "") return;
    this.strings.push([String(value), symbol]);
    // Longest first, so one id that contains another is replaced whole.
    this.strings.sort((a, b) => b[0].length - a[0].length);
  }

  private number(family: string, value: string): string {
    let m = this.numbered.get(family);
    if (!m) this.numbered.set(family, (m = new Map()));
    if (!m.has(value)) m.set(value, `<${family}#${m.size + 1}>`);
    return m.get(value)!;
  }

  text(raw: string): string {
    // Gzipped JSON embedded as a serialized Buffer (participationInit's PCA
    // cache item) is decoded so the same normalization applies inside it.
    let out = raw.replace(
      /\{"type":"Buffer","data":\[([\d,]*)\]\}/g,
      (whole, bytes: string) => {
        const buf = Buffer.from(bytes ? bytes.split(",").map(Number) : []);
        if (buf[0] !== 0x1f || buf[1] !== 0x8b) return whole;
        return JSON.stringify({ $gunzip: gunzipSync(buf).toString("utf8") });
      }
    );
    for (const [value, symbol] of this.strings)
      out = out.split(value).join(symbol);
    out = out
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
      // supertest serves each request on an ephemeral local port
      .replace(/http:\/\/127\.0\.0\.1:\d+/g, "<local-origin>")
      .replace(
        /"(zid|uid|owner|org_id|site_id)":(-?\d+)/g,
        (_m, key: string, value: string) =>
          `"${key}":"${this.number(
            key === "zid" ? "zid" : key === "site_id" ? "site" : "uid",
            value
          )}"`
      )
      .replace(
        /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
        "<iso>"
      )
      .replace(
        /[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \([^)]*\)/g,
        "<datetime>"
      )
      .replace(/polis_site_id_[A-Za-z0-9]+/g, "<site-id>")
      .replace(/\b1\d{15}\b/g, "<us>")
      .replace(/\b1\d{12}\b/g, "<ms>")
      .replace(/\b1\d{9}\b/g, "<s>");
    return out;
  }
}

const norm = new Normalizer();

// comments-bulk requires original_id to be a UUID; one fresh UUID per label
// per run, normalized to <orig:LABEL>.
const origIds = new Map<string, string>();
function orig(label: string): string {
  if (!origIds.has(label)) {
    const id = randomUUID();
    origIds.set(label, id);
    norm.name(id, `<orig:${label}>`);
  }
  return origIds.get(label)!;
}

// Wire votes come from the tests' wire helper; no vote number is written here.
const AGREE = toWire("agree");
const DISAGREE = toWire("disagree");
const PASS = toWire("pass");

// The votes-bulk import CSV and the participant-votes.csv cells use the EXPORT
// convention (agree = +1, the admin import screen's documented format). The
// tests have no export-convention helper; this one line states it.
const EXPORT_VOTE = { agree: "1", disagree: "-1", pass: "0" } as const;

// participationInit's "no participant yet" sentinel (a participant id).
const NEW_PID = "pid=-1";

/**
 * Order exemptions. Each names a response whose row order edge does not
 * define (a query with no ORDER BY, or ties inside one). Its rows are compared
 * as a set, sorted by a key; every row's bytes are still exact, and the JSON
 * must be the compact JSON it always is or the exemption refuses rather than
 * reserializing. Reordering runs on the raw bytes, before normalization, so
 * rows are matched by identity (pid, tid, created) before their vote is seen.
 *
 *  - every GET /comments list: the moderation list with voting patterns is a
 *    `full outer join` and the others a plain select, none ordered
 *    (src/comment.ts); two edge runs returned different orders. Sorted by tid.
 *  - the votes_latest_unique rows of GET /votes and participationInit's
 *    `votes` (src/routes/votes.ts, votesGet): rows move when ON CONFLICT
 *    updates them, so a changed vote reorders the heap. Sorted by (pid, tid).
 *  - GET /votes/me (`SELECT * FROM votes WHERE zid AND pid`, no ORDER BY): a
 *    changed vote's history rows. Sorted by (pid, tid, created).
 *  - comments.csv and comment-clusters.csv (no ORDER BY; physical order moved
 *    after a moderation UPDATE). Sorted by comment-id.
 *  - votes.csv (`ORDER BY tid, pid`): a changed vote's history rows tie. The
 *    ORDER BY is kept; inside one (tid, pid) group lines are put in timestamp
 *    order, and the cases make every changed vote land in a distinct second
 *    (a same-second tie throws), so a flipped history row is visible.
 *
 * participant-votes.csv keeps the LAST row it streams for each (pid, tid)
 * under that same tie, so for a changed vote the cell -- and the row's
 * n-agree/n-disagree, which count the cells -- are whichever history row the
 * sort left last. Edge does not define that value, so it is not pinned.
 * Instead, for a participant with a changed vote, each changed cell must be
 * the export value of one of that (pid, tid)'s stored history rows
 * (<changed-vote:in-history>), and n-agree/n-disagree must equal the row's own
 * agree/disagree cells (<counts:consistent>). Anything else is written into
 * the recording and fails the comparison.
 */
type Row = { tid: number; pid?: number };
type HistoryRow = Row & { created?: string | number; vote?: number | null };
const byPidTid = (a: HistoryRow, b: HistoryRow) =>
  (a.pid ?? 0) - (b.pid ?? 0) ||
  a.tid - b.tid ||
  Number(a.created ?? 0) - Number(b.created ?? 0) ||
  (a.vote ?? 9) - (b.vote ?? 9);
const byTid = (a: Row, b: Row) => a.tid - b.tid;
const UNORDERED: Array<{
  pattern: RegExp;
  field: string | null;
  sort: (a: HistoryRow, b: HistoryRow) => number;
}> = [
  { pattern: /\/comments\//, field: null, sort: byTid },
  {
    pattern: /\/votes-(mypid|pid-\d+(-tid-\d+)?|no-pid)$/,
    field: null,
    sort: byPidTid,
  },
  { pattern: /participationInit/, field: "votes", sort: byPidTid },
  { pattern: /\/votes-me$/, field: null, sort: byPidTid },
];

function csvParts(text: string) {
  const lines = text.split("\n");
  const trailing = lines[lines.length - 1] === "";
  const rows = lines.slice(1, trailing ? lines.length - 1 : lines.length);
  return { header: lines[0], rows, trailing };
}

function csvJoin(header: string, rows: string[], trailing: boolean) {
  return [header, ...rows, ...(trailing ? [""] : [])].join("\n");
}

/** comments.csv, comment-clusters.csv: rows sorted by their unique comment-id. */
function sortByCommentId(text: string): string {
  const { header, rows, trailing } = csvParts(text);
  const at = header.split(",").indexOf("comment-id");
  if (at < 0) return text;
  const id = (l: string) => Number(l.split(",")[at]);
  return csvJoin(
    header,
    [...rows].sort((a, b) => id(a) - id(b)),
    trailing
  );
}

/** votes.csv: timestamp order inside each (comment-id, voter-id) tie group. */
function unorderTies(name: string, text: string): string {
  const { header, rows, trailing } = csvParts(text);
  const cols = header.split(",");
  const tidAt = cols.indexOf("comment-id");
  const pidAt = cols.indexOf("voter-id");
  const tsAt = cols.indexOf("timestamp");
  const key = (l: string) => {
    const f = l.split(",");
    return [Number(f[tidAt]), Number(f[pidAt]), Number(f[tsAt])];
  };
  const sorted = [...rows].sort((a, b) => {
    const [ta, pa, sa] = key(a);
    const [tb, pb, sb] = key(b);
    return ta - tb || pa - pb || sa - sb;
  });
  sorted.forEach((l, i) => {
    const [t, p, ts] = key(l);
    const [t0, p0] = key(rows[i]);
    // The ORDER BY tid, pid must already hold; only ties may move.
    if (t !== t0 || p !== p0)
      throw new Error(`${name}: not in (tid, pid) order`);
    if (i > 0) {
      const [tp, pp, tsp] = key(sorted[i - 1]);
      if (t === tp && p === pp && ts === tsp)
        throw new Error(`${name}: two history rows share a second`);
    }
  });
  return csvJoin(header, sorted, trailing);
}

/** The export value of a stored vote (NULL exports as 0, as edge writes it). */
function exportOfStored(stored: number | null): string {
  if (stored === null) return EXPORT_VOTE.pass;
  const vote = fromWire(stored); // storage equals the wire today
  return vote ? EXPORT_VOTE[vote] : `stored:${stored}`;
}

/** participant-votes.csv: verify, then mark, the changed-vote cells. */
function checkChangedVoteRows(
  text: string,
  history: Map<string, Array<number | null>>
): string {
  const { header, rows, trailing } = csvParts(text);
  const cols = header.split(",");
  const agreeAt = cols.indexOf("n-agree");
  const disagreeAt = cols.indexOf("n-disagree");
  const tidCols = cols
    .map((h, i) => [h, i] as const)
    .filter(([h]) => /^\d+$/.test(h));
  const out = rows.map((line) => {
    if (!line) return line;
    const f = line.split(",");
    const changed = tidCols.filter(([h]) => history.has(`${f[0]}:${h}`));
    if (!changed.length) return line;
    const cells = tidCols.map(([, i]) => f[i]);
    const agrees = cells.filter((c) => c === EXPORT_VOTE.agree).length;
    const disagrees = cells.filter((c) => c === EXPORT_VOTE.disagree).length;
    const consistent =
      String(agrees) === f[agreeAt] && String(disagrees) === f[disagreeAt];
    for (const [h, i] of changed) {
      const allowed = history.get(`${f[0]}:${h}`)!.map(exportOfStored);
      f[i] = allowed.includes(f[i])
        ? "<changed-vote:in-history>"
        : `<changed-vote:NOT-IN-HISTORY:${f[i]}>`;
    }
    f[agreeAt] = consistent
      ? "<counts:consistent>"
      : `<counts:INCONSISTENT:${f[agreeAt]}>`;
    f[disagreeAt] = consistent
      ? "<counts:consistent>"
      : `<counts:INCONSISTENT:${f[disagreeAt]}>`;
    return f.join(",");
  });
  return csvJoin(header, out, trailing);
}

function unorder(name: string, text: string): string {
  if (name.endsWith("/votes.csv")) return unorderTies(name, text);
  if (/\/(comments|comment-clusters)\.csv$/.test(name))
    return sortByCommentId(text);
  const rule = UNORDERED.find((r) => r.pattern.test(name));
  if (!rule || !text.startsWith(rule.field ? "{" : "[")) return text;
  const parsed = JSON.parse(text);
  if (JSON.stringify(parsed) !== text)
    throw new Error(`${name}: not compact JSON, cannot reorder exactly`);
  if (rule.field === null) return JSON.stringify([...parsed].sort(rule.sort));
  if (Array.isArray(parsed[rule.field])) parsed[rule.field].sort(rule.sort);
  return JSON.stringify(parsed);
}

function record(name: string, obs: Observation) {
  if (observed.has(name)) throw new Error(`duplicate case ${name}`);
  // Reorder the raw (valid JSON) bytes first, then normalize.
  const text = norm.text(
    obs.status === 200 ? unorder(name, obs.text) : obs.text
  );
  observed.set(name, {
    status: obs.status,
    contentType: obs.contentType,
    text,
  });
}

function recordResponse(name: string, response: Response) {
  const contentType = response.headers["content-type"] ?? null;
  record(name, {
    status: response.status,
    contentType: contentType ? String(contentType) : null,
    text: response.text ?? "",
  });
}

async function recordQuery(name: string, sql: string, params: unknown[]) {
  const rows = (await pool.query(sql, params)).rows;
  record(name, {
    status: 0,
    contentType: "db/rows",
    text: JSON.stringify(rows),
  });
}

type Agent = ReturnType<typeof request.agent>;

/**
 * Every agent talks to ONE server this file starts on 127.0.0.1, built on this
 * file's own app instance. supertest's default (listen on every interface,
 * then dial 127.0.0.1) can reach another local process that holds the same
 * port number on 127.0.0.1 only; binding 127.0.0.1 ourselves rules that out.
 */
let server: http.Server | null = null;
async function newAgent(): Promise<Agent> {
  if (!server) {
    const app = await createAppInstance();
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve())
    );
  }
  return request.agent(server);
}

/** POST with the participant's own token picked up from the response. */
async function post(
  agent: Agent,
  url: string,
  body: object
): Promise<Response> {
  const response = await agent.post(url).send(body);
  const token = response.body?.auth?.token;
  if (token) agent.set("Authorization", `Bearer ${token}`);
  return response;
}

async function getJson(agent: Agent, url: string): Promise<Response> {
  const response = await agent.get(url);
  const token = response.body?.auth?.token;
  if (token) agent.set("Authorization", `Bearer ${token}`);
  return response;
}

async function zidOf(conversationId: string): Promise<number> {
  const rows = (
    await pool.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
      conversationId,
    ])
  ).rows;
  return rows[0].zid;
}

/**
 * Wait for the handlers' deferred updates (POST /votes and POST /comments run
 * updateVoteCount and the modified/last-interaction updates on a 100 ms timer)
 * before reading. Polls instead of sleeping: done when every participant's
 * vote_count equals its stored rows and the conversation's participant and
 * modified state has not changed across three polls. A path that never
 * updates vote_count is accepted once its state has been still for 2 s.
 */
async function settle(zid: number): Promise<void> {
  const state = async () =>
    JSON.stringify(
      (
        await pool.query(
          `SELECT p.pid, p.vote_count, p.last_interaction, c.modified,
                  (SELECT count(*) FROM votes v WHERE v.zid = p.zid AND v.pid = p.pid) AS stored
             FROM participants p JOIN conversations c ON c.zid = p.zid
            WHERE p.zid = $1 ORDER BY p.pid`,
          [zid]
        )
      ).rows
    );
  const counted = (snapshot: string) =>
    (
      JSON.parse(snapshot) as Array<{ vote_count: number; stored: string }>
    ).every((r) => Number(r.vote_count) === Number(r.stored));
  const deadline = Date.now() + 15000;
  let last = await state();
  let stillSince = Date.now();
  let stillPolls = 0;
  for (;;) {
    await wait(150);
    const now = await state();
    if (now === last) stillPolls++;
    else {
      last = now;
      stillPolls = 0;
      stillSince = Date.now();
    }
    if (stillPolls >= 3 && (counted(now) || Date.now() - stillSince >= 2000))
      return;
    if (Date.now() > deadline) throw new Error(`zid ${zid} did not settle`);
  }
}

// Changed votes are spaced so each lands in its own second (votes.csv carries
// whole seconds, and a same-second history would tie).
const NEXT_SECOND_MS = 1100;

const REPORT_TYPES = [
  "summary.csv",
  "comments.csv",
  "votes.csv",
  "participant-votes.csv",
  "participant-importance.csv",
  "comment-groups.csv",
  "comment-clusters.csv",
];

const STORED_VOTES =
  "SELECT pid, tid, vote, weight_x_32767, high_priority FROM votes WHERE zid = $1 ORDER BY pid, tid, created, vote";
const STORED_LATEST =
  "SELECT pid, tid, vote, weight_x_32767 FROM votes_latest_unique WHERE zid = $1 ORDER BY pid, tid";

describe("vote paths serve exactly the bytes edge served", () => {
  let owner: Agent;
  let admin: Agent;
  const cleanupZids: number[] = [];

  async function newConversation(name: string, extra: object = {}) {
    const response = await owner.post("/api/v3/conversations").send({
      topic: `Vote path ${name} ${RUN}`,
      description: `Vote path recording: ${name}`,
      is_active: true,
      is_anon: false,
      is_draft: false,
      strict_moderation: false,
      profanity_filter: false,
      spam_filter: false,
      ...extra,
    });
    const conversationId: string = response.body.conversation_id;
    norm.name(conversationId, `<conv:${name}>`);
    recordResponse(`${name}/create-conversation`, response);
    const zid = await zidOf(conversationId);
    cleanupZids.push(zid);
    return { conversationId, zid };
  }

  async function newReport(name: string, conversationId: string) {
    await owner
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    const reports = await owner.get(
      `/api/v3/reports?conversation_id=${conversationId}`
    );
    const reportId: string = reports.body[0].report_id;
    norm.name(reportId, `<report:${name}>`);
    return reportId;
  }

  async function recordExports(name: string, reportId: string) {
    const zid = (
      await pool.query("SELECT zid FROM reports WHERE report_id = $1", [
        reportId,
      ])
    ).rows[0].zid;
    // (pid, tid) -> its stored history, for every changed vote.
    const history = new Map<string, Array<number | null>>(
      (
        await pool.query(
          "SELECT pid, tid, array_agg(vote ORDER BY created) AS stored FROM votes WHERE zid = $1 GROUP BY pid, tid HAVING count(*) > 1",
          [zid]
        )
      ).rows.map(
        (r: { pid: number; tid: number; stored: Array<number | null> }) => [
          `${r.pid}:${r.tid}`,
          r.stored,
        ]
      )
    );
    for (const type of REPORT_TYPES) {
      const response = await owner
        .get(`/api/v3/reportExport/${reportId}/${type}`)
        .set("x-forwarded-proto", "http");
      if (type === "participant-votes.csv" && response.status === 200)
        record(`${name}/reportExport/${type}`, {
          status: response.status,
          contentType: response.headers["content-type"]
            ? String(response.headers["content-type"])
            : null,
          text: checkChangedVoteRows(response.text, history),
        });
      else recordResponse(`${name}/reportExport/${type}`, response);
    }
  }

  async function recordModerationLists(name: string, conversationId: string) {
    const base = `/api/v3/comments?conversation_id=${conversationId}`;
    for (const [label, query] of [
      [
        "moderation-voting-patterns",
        "&moderation=true&include_voting_patterns=true",
      ],
      [
        "moderation-voting-patterns-mod-out",
        "&moderation=true&include_voting_patterns=true&mod=-1",
      ],
      [
        "moderation-voting-patterns-mod-in",
        "&moderation=true&include_voting_patterns=true&modIn=true",
      ],
      ["moderation-no-voting-patterns", "&moderation=true"],
      ["comments-plain", ""],
    ])
      recordResponse(
        `${name}/comments/${label}`,
        await owner.get(base + query)
      );
  }

  async function recordStored(name: string, zid: number) {
    await recordQuery(`${name}/db/votes`, STORED_VOTES, [zid]);
    await recordQuery(`${name}/db/votes_latest_unique`, STORED_LATEST, [zid]);
  }

  beforeAll(async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);

    const ownerUser = getPooledTestUser(
      RESERVED_POOLED_USER_INDEXES.votePathRecordings
    );
    // Every agent is built on this file's own app instance (newAgent), never
    // on the shared one globalSetup creates: that app runs in another realm,
    // where the Math.random pin and the query spy below do not reach.
    owner = await newAgent();
    owner.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: ownerUser.email,
        password: ownerUser.password,
      })}`
    );
    // admin@polis.test carries the delphi_enabled claim the collective
    // statement route requires.
    admin = await newAgent();
    admin.set(
      "Authorization",
      `Bearer ${await getOidcToken({
        email: "admin@polis.test",
        password: "Te$tP@ssw0rd*",
      })}`
    );

    // ----------------------------------------------------------------------
    // V: the main conversation. Owner seeds comments with every vote value.
    // ----------------------------------------------------------------------
    const V = await newConversation("V");
    recordResponse(
      "V/put-importance-enabled",
      await owner
        .put("/api/v3/conversations")
        .send({ conversation_id: V.conversationId, importance_enabled: true })
    );
    const commentBodies: Array<[string, object]> = [
      ["c0-seed-default-vote", { is_seed: true }],
      ["c1-owner-agree", { vote: AGREE }],
      ["c2-owner-disagree", { vote: DISAGREE }],
      ["c3-owner-pass", { vote: PASS }],
      ["c4-no-vote", {}],
      ["c5-to-moderate-out", {}],
      ["c6-seed-explicit-agree", { is_seed: true, vote: AGREE }],
    ];
    for (const [label, extra] of commentBodies)
      recordResponse(
        `V/post-comment/${label}`,
        await post(owner, "/api/v3/comments", {
          conversation_id: V.conversationId,
          txt: `Vote path statement ${label}`,
          ...extra,
        })
      );
    for (const [label, vote] of [
      ["out-of-range-2", 2],
      ["out-of-range-minus-2", -2],
      ["non-integer-string", "agree"],
    ] as Array<[string, unknown]>)
      recordResponse(
        `V/post-comment/rejected-${label}`,
        await post(owner, "/api/v3/comments", {
          conversation_id: V.conversationId,
          txt: `Vote path rejected ${label}`,
          vote,
        })
      );
    recordResponse(
      "V/moderate-out-c5",
      await owner.put("/api/v3/comments").send({
        conversation_id: V.conversationId,
        tid: 5,
        active: true,
        mod: -1,
        is_meta: false,
        velocity: 1,
      })
    );
    await settle(V.zid);
    await recordStored("V/after-owner-comments", V.zid);

    // Anonymous participant A.
    const A = await newAgent();
    recordResponse(
      "V/A/participationInit-before-votes",
      await getJson(
        A,
        `/api/v3/participationInit?conversation_id=${V.conversationId}&${NEW_PID}&lang=en`
      )
    );
    const voteA = async (
      label: string,
      tid: number,
      vote: unknown,
      extra = {}
    ) =>
      recordResponse(
        `V/A/vote/${label}`,
        await post(A, "/api/v3/votes", {
          conversation_id: V.conversationId,
          tid,
          vote,
          lang: "en",
          ...extra,
        })
      );
    await voteA("t0-agree", 0, AGREE);
    await voteA("t1-disagree", 1, DISAGREE);
    await voteA("t2-pass", 2, PASS);
    await voteA("t3-change-1-agree", 3, AGREE);
    await wait(NEXT_SECOND_MS);
    await voteA("t3-change-2-disagree", 3, DISAGREE);
    await wait(NEXT_SECOND_MS);
    await voteA("t3-change-3-pass", 3, PASS);
    await voteA("t4-agree-high-priority", 4, AGREE, { high_priority: true });
    await voteA("t5-moderated-out-agree", 5, AGREE);
    await voteA("t6-disagree-starred", 6, DISAGREE, { starred: true });
    await voteA("rejected-out-of-range-2", 0, 2);
    await voteA("rejected-out-of-range-minus-2", 0, -2);
    await voteA("rejected-string", 0, "agree");
    await voteA("rejected-missing-vote", 0, undefined);

    // XID participant X.
    const xid = `${RUN}-xid-1`;
    const X = await newAgent();
    recordResponse(
      "V/X/participationInit-before-votes",
      await getJson(
        X,
        `/api/v3/participationInit?conversation_id=${V.conversationId}&xid=${xid}&${NEW_PID}&lang=en`
      )
    );
    const voteX = async (label: string, tid: number, vote: number) =>
      recordResponse(
        `V/X/vote/${label}`,
        await post(X, "/api/v3/votes", {
          conversation_id: V.conversationId,
          xid,
          tid,
          vote,
          lang: "en",
        })
      );
    await voteX("t0-disagree", 0, DISAGREE);
    await voteX("t1-agree", 1, AGREE);
    await voteX("t2-pass", 2, PASS);
    await voteX("t3-change-1-pass", 3, PASS);
    await wait(NEXT_SECOND_MS);
    await voteX("t3-change-2-agree", 3, AGREE);
    await wait(NEXT_SECOND_MS);
    await voteX("t3-change-3-disagree", 3, DISAGREE);
    await voteX("t5-moderated-out-disagree", 5, DISAGREE);

    // Anonymous participant B votes once; C never votes.
    const B = await newAgent();
    recordResponse(
      "V/B/vote/t1-agree",
      await post(B, "/api/v3/votes", {
        conversation_id: V.conversationId,
        tid: 1,
        vote: AGREE,
        lang: "en",
      })
    );
    // B (no changed votes) also votes on a tid that does not exist.
    recordResponse(
      "V/B/vote/unknown-tid-99-agree",
      await post(B, "/api/v3/votes", {
        conversation_id: V.conversationId,
        tid: 99,
        vote: AGREE,
        lang: "en",
      })
    );
    // The owner (an OIDC user) votes through POST /votes, not only through
    // POST /comments.
    recordResponse(
      "V/owner/vote/t4-agree",
      await post(owner, "/api/v3/votes", {
        conversation_id: V.conversationId,
        tid: 4,
        vote: AGREE,
        lang: "en",
      })
    );
    recordResponse(
      "V/owner/vote/t5-moderated-out-disagree",
      await post(owner, "/api/v3/votes", {
        conversation_id: V.conversationId,
        tid: 5,
        vote: DISAGREE,
        lang: "en",
      })
    );
    const C = await newAgent();
    recordResponse(
      "V/C/participationInit-no-votes",
      await getJson(
        C,
        `/api/v3/participationInit?conversation_id=${V.conversationId}&${NEW_PID}&lang=en`
      )
    );
    await settle(V.zid);
    await recordStored("V/after-participant-votes", V.zid);
    await recordQuery(
      "V/db/participants",
      "SELECT pid, vote_count, mod FROM participants WHERE zid = $1 ORDER BY pid",
      [V.zid]
    );

    // Reads.
    const vq = `conversation_id=${V.conversationId}`;
    for (const [actor, agent] of [
      ["A", A],
      ["X", X],
      ["B", B],
      ["C", C],
      ["owner", owner],
    ] as Array<[string, Agent]>) {
      recordResponse(
        `V/${actor}/votes-me`,
        await agent.get(`/api/v3/votes/me?${vq}`)
      );
      recordResponse(
        `V/${actor}/votes-mypid`,
        await agent.get(`/api/v3/votes?${vq}&pid=mypid`)
      );
      recordResponse(
        `V/${actor}/votes-famous`,
        await agent.get(`/api/v3/votes/famous?${vq}`)
      );
      recordResponse(
        `V/${actor}/participationInit-after-votes`,
        await agent.get(`/api/v3/participationInit?${vq}&${NEW_PID}&lang=en`)
      );
      recordResponse(
        `V/${actor}/nextComment`,
        await agent.get(
          `/api/v3/nextComment?${vq}&not_voted_by_pid=mypid&lang=en`
        )
      );
    }
    const anon = await newAgent();
    recordResponse(
      "V/unauthenticated/votes-me",
      await anon.get(`/api/v3/votes/me?${vq}`)
    );
    recordResponse(
      "V/unauthenticated/votes-famous",
      await anon.get(`/api/v3/votes/famous?${vq}`)
    );
    for (let pid = 0; pid <= 4; pid++) {
      recordResponse(
        `V/owner/votes-pid-${pid}`,
        await owner.get(`/api/v3/votes?${vq}&pid=${pid}`)
      );
      recordResponse(
        `V/owner/votes-pid-${pid}-tid-3`,
        await owner.get(`/api/v3/votes?${vq}&pid=${pid}&tid=3`)
      );
    }
    recordResponse(
      "V/owner/votes-no-pid",
      await owner.get(`/api/v3/votes?${vq}`)
    );
    recordResponse(
      "V/unauthenticated/votes-pid-1",
      await anon.get(`/api/v3/votes?${vq}&pid=1`)
    );
    recordResponse(
      "V/owner/votes-famous-math-tick-0",
      await owner.get(`/api/v3/votes/famous?${vq}&math_tick=0`)
    );
    await recordModerationLists("V", V.conversationId);
    recordResponse(
      "V/owner/conversationStats",
      await owner.get(`/api/v3/conversationStats?${vq}`)
    );
    const reportV = await newReport("V", V.conversationId);
    await recordExports("V", reportV);
    const zinviteUuid = (
      await pool.query("SELECT uuid FROM zinvites WHERE zid = $1", [V.zid])
    ).rows[0]?.uuid;
    norm.name(zinviteUuid, "<uuid:V>");
    recordResponse(
      "V/xid-report",
      await owner.get(`/api/v3/xid/${zinviteUuid}-xid.csv`)
    );

    // The collective statement's topic query: record the SQL text it sends and
    // the vote counts it reads back. One qualifying tid (< 3) returns before
    // the model is called.
    await createDelphiTopicCluster(
      V.zid,
      "layer0_1",
      [0, 1, 2, 3, 4, 5, 6],
      0,
      1
    );
    const captured: Array<{ sql: string; rows: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgAny = pgQuery as any;
    const originalQueryP = pgAny.queryP;
    const spy = jest
      .spyOn(pgAny, "queryP")
      .mockImplementation(async (sql: unknown, params?: unknown) => {
        const rows = await originalQueryP.call(pgQuery, sql, params);
        if (String(sql).includes("as comment_id"))
          captured.push({ sql: String(sql), rows });
        return rows;
      });
    try {
      recordResponse(
        "V/collectiveStatement/response",
        await admin.post("/api/v3/collectiveStatement").send({
          report_id: reportV,
          topic_key: "layer0_1",
          topic_name: "Vote path topic",
          qualifying_tids: [0],
          group_consensus: { 0: 0.9 },
        })
      );
    } finally {
      spy.mockRestore();
    }
    record("V/collectiveStatement/topic-query", {
      status: 0,
      contentType: "db/query",
      text: JSON.stringify(captured),
    });

    // ----------------------------------------------------------------------
    // E: an empty conversation (no comments, no votes).
    // ----------------------------------------------------------------------
    const E = await newConversation("E");
    const eq = `conversation_id=${E.conversationId}`;
    const EA = await newAgent();
    recordResponse(
      "E/anonymous/participationInit",
      await getJson(EA, `/api/v3/participationInit?${eq}&${NEW_PID}&lang=en`)
    );
    recordResponse(
      "E/anonymous/votes-me",
      await EA.get(`/api/v3/votes/me?${eq}`)
    );
    recordResponse(
      "E/anonymous/votes-famous",
      await EA.get(`/api/v3/votes/famous?${eq}`)
    );
    recordResponse(
      "E/anonymous/nextComment",
      await EA.get(`/api/v3/nextComment?${eq}&not_voted_by_pid=mypid&lang=en`)
    );
    recordResponse(
      "E/owner/votes-me",
      await owner.get(`/api/v3/votes/me?${eq}`)
    );
    recordResponse(
      "E/owner/votes-pid-0",
      await owner.get(`/api/v3/votes?${eq}&pid=0`)
    );
    recordResponse(
      "E/owner/votes-famous",
      await owner.get(`/api/v3/votes/famous?${eq}`)
    );
    recordResponse(
      "E/owner/participationInit",
      await owner.get(`/api/v3/participationInit?${eq}&${NEW_PID}&lang=en`)
    );
    recordResponse(
      "E/owner/conversationStats",
      await owner.get(`/api/v3/conversationStats?${eq}`)
    );
    await recordModerationLists("E", E.conversationId);
    const reportE = await newReport("E", E.conversationId);
    await recordExports("E", reportE);
    await recordStored("E", E.zid);
    // Last, so every read above saw the conversation empty: a vote on a tid
    // that does not exist.
    recordResponse(
      "E/anonymous/vote-no-such-comment",
      await post(EA, "/api/v3/votes", {
        conversation_id: E.conversationId,
        tid: 0,
        vote: AGREE,
      })
    );
    await settle(E.zid);
    await recordStored("E/after-vote-on-missing-comment", E.zid);
    recordResponse(
      "E/after-vote-on-missing-comment/votes.csv",
      await owner
        .get(`/api/v3/reportExport/${reportE}/votes.csv`)
        .set("x-forwarded-proto", "http")
    );

    // ----------------------------------------------------------------------
    // Z: comments but zero votes.
    // ----------------------------------------------------------------------
    const Z = await newConversation("Z");
    const zq = `conversation_id=${Z.conversationId}`;
    for (const label of ["z0", "z1"])
      recordResponse(
        `Z/post-comment/${label}-no-vote`,
        await post(owner, "/api/v3/comments", {
          conversation_id: Z.conversationId,
          txt: `Vote path zero-vote statement ${label}`,
        })
      );
    await settle(Z.zid);
    const ZA = await newAgent();
    recordResponse(
      "Z/anonymous/participationInit",
      await getJson(ZA, `/api/v3/participationInit?${zq}&${NEW_PID}&lang=en`)
    );
    recordResponse(
      "Z/owner/votes-me",
      await owner.get(`/api/v3/votes/me?${zq}`)
    );
    recordResponse(
      "Z/owner/votes-pid-0",
      await owner.get(`/api/v3/votes?${zq}&pid=0`)
    );
    recordResponse(
      "Z/owner/votes-famous",
      await owner.get(`/api/v3/votes/famous?${zq}`)
    );
    await recordModerationLists("Z", Z.conversationId);
    await recordExports("Z", await newReport("Z", Z.conversationId));
    await recordStored("Z", Z.zid);

    // ----------------------------------------------------------------------
    // I: the bulk paths. Seed comments through comments-bulk (each takes the
    // owner's default pass vote), then votes through the import worker, whose
    // CSV is in the export convention (agree = +1).
    // ----------------------------------------------------------------------
    const I = await newConversation("I");
    const iq = `conversation_id=${I.conversationId}`;
    recordResponse(
      "I/comments-bulk-seed",
      await owner.post("/api/v3/comments-bulk").send({
        conversation_id: I.conversationId,
        is_seed: true,
        csv: [
          "comment_text,original_id",
          `Vote path import statement a,${orig("a")}`,
          `Vote path import statement b,${orig("b")}`,
          `Vote path import statement c,${orig("c")}`,
        ].join("\n"),
      })
    );
    recordResponse(
      "I/votes-bulk-route-owner",
      await owner.post("/api/v3/votes-bulk").send({
        conversation_id: I.conversationId,
        csv: "vote_id,user_id,vote_value,timestamp,comment_id\n",
      })
    );
    await settle(I.zid);
    await recordStored("I/after-comments-bulk", I.zid);

    const runImport = async (label: string, zid: number, rows: string[][]) => {
      const csv = [
        "vote_id,user_id,vote_value,timestamp,comment_id",
        ...rows.map((r) => r.join(",")),
      ].join("\n");
      const s3Key = `imports/votes/${zid}/${RUN}-${label}.csv`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
          Key: s3Key,
          Body: csv,
          ContentType: "text/csv",
        })
      );
      const job = (
        await pool.query(
          "INSERT INTO byod_import_jobs (zid, s3_key, status, stage, created_at) VALUES ($1, $2, 'pending', 'mapping', NOW()) RETURNING id",
          [zid, s3Key]
        )
      ).rows[0].id;
      let outcome = "completed";
      try {
        await processImportJob({ jobId: job, zid, s3Key, email: "" });
      } catch (err) {
        outcome = `threw: ${(err as Error)?.message ?? String(err)}`;
      }
      const state = (
        await pool.query(
          "SELECT status, stage, error_message FROM byod_import_jobs WHERE id = $1",
          [job]
        )
      ).rows[0];
      record(`${label}/import-job`, {
        status: 0,
        contentType: "db/rows",
        text: JSON.stringify({ outcome, state }),
      });
    };
    // Users are named by the run token so every run imports fresh identities.
    const u = (n: number) => `${RUN}-u${n}`;
    // A changed vote inside ONE file: both rows land in one INSERT, which
    // the votes rule turns into a double ON CONFLICT update. Recorded as edge
    // behaves (the whole job fails and nothing is written).
    await runImport("I/changed-vote-in-one-file", I.zid, [
      ["1", u(9), EXPORT_VOTE.disagree, "2023-11-14T22:13:20Z", orig("a")],
      ["2", u(9), EXPORT_VOTE.agree, "2023-11-14T22:13:21Z", orig("a")],
    ]);
    // One new user per file: the importer assigns pids from SELECT DISTINCT
    // over unnest, whose order is not defined, so two new users in one file
    // could take either pid.
    await runImport("I/file-u1", I.zid, [
      ["1", u(1), EXPORT_VOTE.agree, "2023-11-14T22:13:20Z", orig("a")],
      ["2", u(1), EXPORT_VOTE.disagree, "2023-11-14T22:13:21Z", orig("b")],
      ["3", u(1), EXPORT_VOTE.pass, "2023-11-14T22:13:22Z", orig("c")],
      ["8", u(1), EXPORT_VOTE.agree, "2023-11-14T22:13:27Z", orig("unknown")],
    ]);
    await runImport("I/file-u2", I.zid, [
      ["4", u(2), EXPORT_VOTE.disagree, "2023-11-14T22:13:23Z", orig("a")],
      ["6", u(2), EXPORT_VOTE.pass, "2023-11-14T22:13:25Z", orig("b")],
    ]);
    await runImport("I/file-u3", I.zid, [
      ["7", u(3), EXPORT_VOTE.agree, "2023-11-14T22:13:26Z", orig("c")],
    ]);
    // Changed votes, in a later file: u2 disagree -> agree, u3 agree -> pass.
    await runImport("I/file-changed-votes", I.zid, [
      ["5", u(2), EXPORT_VOTE.agree, "2023-11-14T22:13:24Z", orig("a")],
      ["9", u(3), EXPORT_VOTE.pass, "2023-11-14T22:13:28Z", orig("c")],
    ]);
    await settle(I.zid);
    await recordStored("I/after-import", I.zid);
    for (let pid = 0; pid <= 3; pid++)
      recordResponse(
        `I/owner/votes-pid-${pid}`,
        await owner.get(`/api/v3/votes?${iq}&pid=${pid}`)
      );
    recordResponse(
      "I/owner/votes-me",
      await owner.get(`/api/v3/votes/me?${iq}`)
    );
    recordResponse(
      "I/owner/votes-famous",
      await owner.get(`/api/v3/votes/famous?${iq}`)
    );
    await recordModerationLists("I", I.conversationId);
    await recordExports("I", await newReport("I", I.conversationId));

    // I2: values outside the export set, then an unparseable one.
    const I2 = await newConversation("I2");
    await owner.post("/api/v3/comments-bulk").send({
      conversation_id: I2.conversationId,
      csv: [
        "comment_text,original_id",
        `Vote path irregular import statement a,${orig("i2a")}`,
        `Vote path irregular import statement b,${orig("i2b")}`,
      ].join("\n"),
    });
    await runImport("I2/out-of-range", I2.zid, [
      ["1", u(21), "2", "2023-11-14T22:13:20Z", `${orig("i2a")}`],
      ["2", u(21), "-2", "2023-11-14T22:13:21Z", `${orig("i2b")}`],
    ]);
    await runImport("I2/unparseable", I2.zid, [
      ["3", u(22), "agree", "2023-11-14T22:13:22Z", `${orig("i2a")}`],
    ]);
    await settle(I2.zid);
    await recordStored("I2/after-import", I2.zid);
    recordResponse(
      "I2/owner/votes-pid-0",
      await owner.get(
        `/api/v3/votes?conversation_id=${I2.conversationId}&pid=0`
      )
    );
    await recordModerationLists("I2", I2.conversationId);
    await recordExports("I2", await newReport("I2", I2.conversationId));

    // POST /votes-bulk with the Delphi-enabled admin: the route itself, through
    // the S3 upload and the job row it queues (no SQS consumer runs here).
    const bulkCsv = [
      "vote_id,user_id,vote_value,timestamp,comment_id",
      ["1", u(4), EXPORT_VOTE.agree, "2023-11-14T22:13:20Z", orig("a")].join(
        ","
      ),
    ].join("\n");
    // The queue send is replaced for this one request (no SQS runs in the
    // test stack, and a real send would leave the machine): the message the
    // route builds is recorded instead, by shape.
    const sent: unknown[] = [];
    const sqsSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(sqsClient as any, "send")
      .mockImplementation(async (command: unknown) => {
        sent.push((command as { input: unknown }).input);
        return {};
      });
    try {
      recordResponse(
        "I/votes-bulk-route-admin",
        await admin
          .post("/api/v3/votes-bulk")
          .send({ conversation_id: I.conversationId, csv: bulkCsv })
      );
    } finally {
      sqsSpy.mockRestore();
    }
    record("I/votes-bulk-route-admin/queued-message", {
      status: 0,
      contentType: "sqs/message",
      text: JSON.stringify(
        sent.map((input) => {
          const m = input as {
            MessageBody: string;
            MessageAttributes: unknown;
          };
          const body = JSON.parse(m.MessageBody);
          return {
            keys: Object.keys(body),
            zidMatches: body.zid === I.zid,
            jobIdIsNumber: typeof body.jobId === "number",
            s3KeyShape: /^imports\/votes\/\d+\/\d+\.csv$/.test(body.s3Key),
            email: body.email,
            attributes: m.MessageAttributes,
          };
        })
      ),
    });
    const bulkJob = (
      await pool.query(
        "SELECT id, status, stage, error_message, s3_key FROM byod_import_jobs WHERE zid = $1 AND s3_key NOT LIKE $2 ORDER BY id DESC LIMIT 1",
        [I.zid, `%${RUN}%`]
      )
    ).rows[0];
    let bulkObject = "absent";
    if (bulkJob?.s3_key) {
      try {
        const got = await s3Client.send(
          new GetObjectCommand({
            Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
            Key: bulkJob.s3_key,
          })
        );
        bulkObject =
          (await got.Body?.transformToString()) === bulkCsv
            ? "uploaded, bytes equal to the posted csv"
            : "uploaded, bytes differ";
      } catch (err) {
        bulkObject = `absent: ${(err as Error)?.name}`;
      }
    }
    record("I/votes-bulk-route-admin/job", {
      status: 0,
      contentType: "db/rows",
      text: JSON.stringify({
        job: bulkJob
          ? {
              status: bulkJob.status,
              stage: bulkJob.stage,
              error_message: bulkJob.error_message,
              s3_key_shape: /^imports\/votes\/\d+\/\d+\.csv$/.test(
                bulkJob.s3_key
              ),
            }
          : null,
        object: bulkObject,
      }),
    });
    await settle(I.zid);
    await recordStored("I/after-votes-bulk-route", I.zid);

    // ----------------------------------------------------------------------
    // CL: a closed conversation refuses votes.
    // ----------------------------------------------------------------------
    const CL = await newConversation("CL");
    await post(owner, "/api/v3/comments", {
      conversation_id: CL.conversationId,
      txt: "Vote path closed statement",
    });
    const CLA = await newAgent();
    recordResponse(
      "CL/anonymous/vote-before-close",
      await post(CLA, "/api/v3/votes", {
        conversation_id: CL.conversationId,
        tid: 0,
        vote: AGREE,
        lang: "en",
      })
    );
    recordResponse(
      "CL/close",
      await owner
        .put("/api/v3/conversations")
        .send({ conversation_id: CL.conversationId, is_active: false })
    );
    recordResponse(
      "CL/anonymous/vote-after-close",
      await post(CLA, "/api/v3/votes", {
        conversation_id: CL.conversationId,
        tid: 0,
        vote: DISAGREE,
        lang: "en",
      })
    );
    recordResponse(
      "CL/owner/vote-after-close",
      await post(owner, "/api/v3/votes", {
        conversation_id: CL.conversationId,
        tid: 0,
        vote: AGREE,
        lang: "en",
      })
    );
    await settle(CL.zid);
    await recordStored("CL", CL.zid);

    // ----------------------------------------------------------------------
    // R: stored values no client can post. votes.vote is a nullable SMALLINT
    // with no CHECK; write NULL, 2 and -2 rows directly and read them back
    // through every reader.
    // ----------------------------------------------------------------------
    const R = await newConversation("R");
    const rq = `conversation_id=${R.conversationId}`;
    for (const label of ["r0", "r1", "r2", "r3"])
      await post(owner, "/api/v3/comments", {
        conversation_id: R.conversationId,
        txt: `Vote path irregular statement ${label}`,
      });
    const RA = await newAgent();
    recordResponse(
      "R/RA/vote/t0-agree",
      await post(RA, "/api/v3/votes", {
        conversation_id: R.conversationId,
        tid: 0,
        vote: AGREE,
        lang: "en",
      })
    );
    await settle(R.zid);
    const raPid = (
      await pool.query(
        "SELECT pid FROM votes WHERE zid = $1 AND tid = 0 ORDER BY created DESC LIMIT 1",
        [R.zid]
      )
    ).rows[0].pid;
    for (const [tid, vote] of [
      [1, null],
      [2, 2],
      [3, -2],
    ] as Array<[number, number | null]>)
      await pool.query(
        "INSERT INTO votes (zid, pid, tid, vote, created) VALUES ($1, $2, $3, $4, $5)",
        [R.zid, raPid, tid, vote, 1700000000000 + tid]
      );
    await pool.query(
      "UPDATE participants SET vote_count = 4 WHERE zid = $1 AND pid = $2",
      [R.zid, raPid]
    );
    await recordStored("R", R.zid);
    recordResponse("R/RA/votes-me", await RA.get(`/api/v3/votes/me?${rq}`));
    recordResponse(
      "R/RA/votes-mypid",
      await RA.get(`/api/v3/votes?${rq}&pid=mypid`)
    );
    recordResponse(
      "R/RA/votes-famous",
      await RA.get(`/api/v3/votes/famous?${rq}`)
    );
    recordResponse(
      "R/RA/participationInit",
      await RA.get(`/api/v3/participationInit?${rq}&${NEW_PID}&lang=en`)
    );
    recordResponse(
      "R/RA/nextComment",
      await RA.get(`/api/v3/nextComment?${rq}&not_voted_by_pid=mypid&lang=en`)
    );
    for (let tid = 1; tid <= 3; tid++)
      recordResponse(
        `R/owner/votes-pid-${raPid}-tid-${tid}`,
        await owner.get(`/api/v3/votes?${rq}&pid=${raPid}&tid=${tid}`)
      );
    await recordModerationLists("R", R.conversationId);
    await recordExports("R", await newReport("R", R.conversationId));
  }, 600000);

  afterAll(async () => {
    (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
    for (const zid of cleanupZids)
      await cleanupDelphiTopicData(zid).catch(() => undefined);
    if (RECORDING) {
      const out: Record<string, Observation> = {};
      for (const [name, obs] of observed) out[name] = obs;
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(out, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.log(`wrote golden: ${GOLDEN_PATH} (${observed.size} cases)`);
    }
    if (server) await new Promise((resolve) => server!.close(resolve));
    await closePool();
  });

  test("the run produced exactly the recorded cases, in the recorded order", () => {
    if (RECORDING) return;
    expect([...observed.keys()]).toEqual(Object.keys(golden));
  });

  // Jest refuses an empty table, so record mode runs one placeholder case.
  test.each(RECORDING ? ["(recording)"] : Object.keys(golden))("%s", (name) => {
    if (RECORDING) return;
    expect(observed.get(name)).toEqual(golden[name]);
  });
});
