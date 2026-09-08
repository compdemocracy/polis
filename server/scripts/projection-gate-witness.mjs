#!/usr/bin/env node
// Projection-gate WIRE witness — SOURCE-BOUND.
//
// The SERVED side is the ACTUAL pinned code: this loads the real function text of
// `votesGet` / `getVotesForSingleParticipant` / `handle_GET_votes` /
// `handle_GET_votes_me` from server/src/routes/votes.ts and `addConversationIds` /
// `finishArray` from server/src/server-helpers.ts (via the TypeScript compiler),
// transpiles it, and runs it in a `vm` context wired to the installed `pg`, `sql`
// and `underscore` — so a change to the real route or serializer (a flipped vote
// sign, a retained `zid`, a missing `pid` filter) changes the SERVED output. It is
// NOT a copy of the query/serializer (Astra round-2 defect 1).
//
// The EXPECTED side is an INDEPENDENT frozen baseline: the frozen explicit column
// projection put through a mirror of finishArray (delete zid, add conversation_id,
// and the votes_me weight transform). Because EXPECTED does not re-run the (possibly
// mutated) real code, a real-code divergence shows up as served != expected.
//
// Read-only: one REPEATABLE READ READ ONLY transaction per site (served + expected
// + the zinvites lookup share the snapshot). Emits JSON to stdout with the exact
// served/expected JSON strings so byte spelling can be verified, not just parsed
// objects.
//
// Deps (typescript, sql, pg, underscore) resolve from server/node_modules; run with
// that on NODE_PATH when invoking from a worktree without an install.

import { createRequire } from "module";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const sql = require("sql");
const _ = require("underscore");
const { Client } = require("pg");

const FROZEN = {
  votes_latest_unique: ["zid", "pid", "tid", "vote", "weight_x_32767", "modified"],
  votes: ["zid", "pid", "tid", "vote", "weight_x_32767", "created", "high_priority"],
};
// vlu definition exactly as server/src/db/sql.ts declares it (so the real
// votesGet's `.star()` renders the identical `"votes_latest_unique".*`).
const VLU_SQLTS_COLUMNS = ["zid", "tid", "pid", "modified", "vote", "weight", "high_priority"];

function parseArgs(argv) {
  const out = { pid: null, tid: null, sites: ["votesGet", "handle_GET_votes_me"], srcRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dsn") out.dsn = argv[++i];
    else if (a === "--zid") out.zid = parseInt(argv[++i], 10);
    else if (a === "--pid") out.pid = parseInt(argv[++i], 10);
    else if (a === "--tid") out.tid = parseInt(argv[++i], 10);
    else if (a === "--sites") out.sites = argv[++i].split(",").filter(Boolean);
    else if (a === "--src-root") out.srcRoot = argv[++i];
  }
  if (!out.dsn || out.zid === undefined || Number.isNaN(out.zid)) {
    throw new Error("usage: --dsn <dsn> --zid <int> [--pid <int>] [--tid <int>] [--sites a,b] [--src-root <server/src>]");
  }
  return out;
}

function pickFunctions(file, names) {
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const picked = ast.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)
  );
  if (picked.length !== names.length) {
    throw new Error(`expected functions [${names}] in ${file}, found ${picked.length}`);
  }
  return picked.map((n) => n.getText(ast)).join("\n");
}

// Build a vm context that runs the REAL route + serializer text against `client`.
function buildRealApp(routeText, serializerText, client, servedPidForGetPid, sqlLog) {
  const context = {
    _,
    sql_votes_latest_unique: sql.define({ name: "votes_latest_unique", columns: VLU_SQLTS_COLUMNS }),
    pg: {
      query_readOnly: (text, a, b) => {
        const cb = typeof a === "function" ? a : b;
        const params = typeof a === "function" ? [] : a;
        sqlLog.last = text;
        client.query(text, params).then((r) => cb(null, r), (e) => cb(e));
      },
    },
    getZinvites: async (zids) =>
      Object.fromEntries(
        (await client.query("SELECT zid, zinvite FROM zinvites WHERE zid = ANY($1)", [zids.map(Number)])).rows.map(
          (r) => [r.zid, r.zinvite]
        )
      ),
    failJson: (_res, _code, message) => {
      throw new Error(String(message));
    },
    // getPid gates on pid >= 0 only; the handler uses req.p.pid for the query.
    getPid: (_zid, _uid, cb) => cb(null, servedPidForGetPid),
    Promise,
    console,
    JSON,
    Number,
    Object,
    Array,
  };
  vm.createContext(context);
  const compiled = ts.transpileModule(routeText + "\n" + serializerText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(compiled, context);
  return context;
}

function driveHandler(context, handlerName, reqp) {
  return new Promise((resolve, reject) => {
    const res = {
      _code: 200,
      status(n) {
        this._code = n;
        return this;
      },
      json(rows) {
        resolve(rows);
      },
    };
    try {
      Promise.resolve(context[handlerName]({ p: reqp }, res)).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Independent frozen baseline: frozen explicit columns + mirror of finishArray.
async function frozenExpected(client, site, zid, pid, tid) {
  let rows;
  if (site === "votesGet") {
    const t = sql.define({ name: "votes_latest_unique", columns: FROZEN.votes_latest_unique });
    let q = t.select.apply(t, FROZEN.votes_latest_unique.map((c) => t[c])).where(t.zid.equals(zid));
    if (pid !== null) q = q.where(t.pid.equals(pid));
    if (tid !== null) q = q.where(t.tid.equals(tid));
    rows = (await client.query(q.toString())).rows;
  } else {
    const cols = FROZEN.votes.map((c) => `"votes"."${c}"`).join(", ");
    if (pid !== null) {
      rows = (await client.query(`SELECT ${cols} FROM votes WHERE zid = ($1) AND pid = ($2)`, [zid, pid])).rows;
    } else {
      rows = (await client.query(`SELECT ${cols} FROM votes WHERE zid = ($1)`, [zid])).rows;
    }
    for (const r of rows) r.weight = r.weight / 32767; // handle_GET_votes_me does this
  }
  // finishArray mirror: addConversationIds (zinvites) then delete zid.
  const zids = [...new Set(rows.filter((r) => r.zid).map((r) => Number(r.zid)))];
  const map = {};
  if (zids.length) {
    const zr = (await client.query("SELECT zid, zinvite FROM zinvites WHERE zid = ANY($1)", [zids])).rows;
    for (const o of zr) map[o.zid] = o.zinvite;
  }
  for (const o of rows) o.conversation_id = map[o.zid];
  for (const o of rows) {
    if (o.zid) delete o.zid;
  }
  return rows;
}

async function captureSite(client, site, a, routeText, serializerText) {
  const pid = a.pid;
  const sqlLog = { last: null };
  const context = buildRealApp(routeText, serializerText, client, pid === null ? 0 : pid, sqlLog);

  let served;
  if (site === "votesGet") {
    served = await driveHandler(context, "handle_GET_votes", { zid: a.zid, pid: pid === null ? undefined : pid, tid: a.tid === null ? undefined : a.tid });
  } else if (site === "handle_GET_votes_me") {
    served = await driveHandler(context, "handle_GET_votes_me", { zid: a.zid, uid: 1, pid: pid === null ? undefined : pid });
  } else {
    throw new Error(`unknown site: ${site}`);
  }
  const expected = await frozenExpected(client, site, a.zid, pid, a.tid);
  return {
    servedSql: sqlLog.last,
    served,
    servedJson: JSON.stringify(served),
    expected,
    expectedJson: JSON.stringify(expected),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const witnessDir = path.dirname(fileURLToPath(import.meta.url)); // server/scripts
  const srcRoot = a.srcRoot || path.join(witnessDir, "..", "src"); // server/src
  const routeText = pickFunctions(path.join(srcRoot, "routes", "votes.ts"), [
    "votesGet",
    "getVotesForSingleParticipant",
    "handle_GET_votes",
    "handle_GET_votes_me",
  ]);
  const serializerText = pickFunctions(path.join(srcRoot, "server-helpers.ts"), [
    "addConversationIds",
    "finishArray",
  ]);

  const client = new Client({ connectionString: a.dsn });
  await client.connect();
  const out = {};
  try {
    for (const site of a.sites) {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        out[site] = await captureSite(client, site, a, routeText, serializerText);
        await client.query("ROLLBACK");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + "\n");
  process.exit(1);
});
