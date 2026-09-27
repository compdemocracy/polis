#!/usr/bin/env node
// Projection-gate WIRE witness — SOURCE-BOUND (route + serializer + SQL builder).
//
// The SERVED side is the ACTUAL pinned code: this loads, from disk, the real
// `sql_votes_latest_unique` builder DEFINITION from server/src/db/sql.ts, the real
// `votesGet` / `getVotesForSingleParticipant` / `handle_GET_votes` /
// `handle_GET_votes_me` from server/src/routes/votes.ts, and the real
// `addConversationIds` / `finishArray` from server/src/server-helpers.ts (via the
// TypeScript compiler), and runs them in a `vm` wired to the installed `pg`/`sql`/
// `underscore`. So a change to the real route, serializer, OR the builder definition
// changes the SERVED output. Nothing is a copy.
//
// The EXPECTED side is an INDEPENDENT frozen baseline: the frozen explicit column
// projection put through a mirror of finishArray (delete zid, add conversation_id,
// the votes_me weight transform), and — pinning the handler's contract — the SAME
// pid gate the real route applies (absent pid -> []). Because EXPECTED does not
// re-run the (possibly mutated) real code, a real-code divergence, an explicit
// refactor that preserves bytes, and a builder change that alters bytes are all
// classified correctly (identical bytes PASS; changed bytes FAIL).
//
// Read-only: one REPEATABLE READ READ ONLY transaction per site. Emits JSON to
// stdout with the exact served/expected JSON strings AND the response status.
//
// Deps (typescript, sql, pg, underscore) resolve from server/node_modules.

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

// Extract the real `const <name> = <initializer>` initializer text from a source
// file, so the ACTUAL builder definition is executed (not a copy).
function pickVariableInitializer(file, name) {
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const stmt of ast.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (decl.name.getText(ast) === name && decl.initializer) {
        return decl.initializer.getText(ast);
      }
    }
  }
  throw new Error(`variable ${name} not found in ${file}`);
}

function buildRealApp(defText, routeText, serializerText, client, servedPidForGetPid, sqlLog) {
  const context = {
    _,
    sql, // the real builder definition runs against the real library
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
    getPid: (_zid, _uid, cb) => cb(null, servedPidForGetPid),
    Promise,
    console,
    JSON,
    Number,
    Object,
    Array,
  };
  vm.createContext(context);
  const module = `const sql_votes_latest_unique = ${defText};\n${routeText}\n${serializerText}`;
  const compiled = ts.transpileModule(module, {
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
        resolve({ status: this._code, rows });
      },
    };
    try {
      Promise.resolve(context[handlerName]({ p: reqp }, res)).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Independent frozen baseline: frozen explicit columns + mirror of finishArray,
// pinning the handler's pid contract (absent pid -> []).
async function frozenExpected(client, site, zid, pid, tid) {
  if (pid === null) return []; // votesGet gates on pid; votes_me query is pid=NULL
  let rows;
  if (site === "votesGet") {
    const t = sql.define({ name: "votes_latest_unique", columns: FROZEN.votes_latest_unique });
    let q = t.select.apply(t, FROZEN.votes_latest_unique.map((c) => t[c])).where(t.zid.equals(zid)).where(t.pid.equals(pid));
    if (tid !== null) q = q.where(t.tid.equals(tid));
    rows = (await client.query(q.toString())).rows;
  } else {
    const cols = FROZEN.votes.map((c) => `"votes"."${c}"`).join(", ");
    rows = (await client.query(`SELECT ${cols} FROM votes WHERE zid = ($1) AND pid = ($2)`, [zid, pid])).rows;
    for (const r of rows) r.weight = r.weight / 32767;
  }
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

async function captureSite(client, site, a, defText, routeText, serializerText) {
  const pid = a.pid;
  const sqlLog = { last: null };
  const context = buildRealApp(defText, routeText, serializerText, client, pid === null ? 0 : pid, sqlLog);

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
    servedStatus: served.status,
    expectedStatus: 200,
    served: served.rows,
    servedJson: JSON.stringify(served.rows),
    expected,
    expectedJson: JSON.stringify(expected),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const witnessDir = path.dirname(fileURLToPath(import.meta.url)); // server/scripts
  const srcRoot = a.srcRoot || path.join(witnessDir, "..", "src"); // server/src
  const defText = pickVariableInitializer(path.join(srcRoot, "db", "sql.ts"), "sql_votes_latest_unique");
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
        out[site] = await captureSite(client, site, a, defText, routeText, serializerText);
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
