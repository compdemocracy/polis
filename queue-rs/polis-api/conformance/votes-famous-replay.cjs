"use strict";
// Raw HTTP fixture proof for GET /api/v3/votes/famous: the featured
// participants of a conversation. No response normalization. The Node source
// is unchanged; every request is sent as the same bytes to Node and to
// polis-api, in the same order, so the process caches on both sides see the
// same history. A request polis-api hands back names its reason in the
// X-Polis-Handback header of its 502, and the reason is checked.
//
// With VOTES_FAMOUS_RECORD_ONLY=1 only Node is asked, and its answers are
// written to /artifacts/votes-famous-node.json: the recordings the handler
// and its contract fixture are written against.
const fs = require("node:fs");
const net = require("node:net");

const NODE = { host: "server", port: 5000 };
const RUST = { host: "polis-api", port: 5100 };
const RECORD_ONLY = process.env.VOTES_FAMOUS_RECORD_ONLY === "1";
const SEED = "7ac001000001";
const INSTANT = 1700000000000;

function exchange(target, bytes, headOnly) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("response deadline")), 10000);
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (b) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      const end = complete(all, headOnly);
      if (end !== null) finish(null, all.subarray(0, end));
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (e) => finish(e));
  });
}

// Offset just past one complete response in `buf`, or null if more is needed.
function complete(buf, headOnly) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString("latin1");
  const status = Number(head.split(" ")[1]);
  let at = headEnd + 4;
  if (headOnly || status === 204 || status === 304 || (status >= 100 && status < 200)) return at;
  if ((header(head, "transfer-encoding") || "").toLowerCase() === "chunked") {
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", at);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(at, lineEnd).toString("latin1"), 16);
      at = lineEnd + 2 + size + 2;
      if (at > buf.length) return null;
      if (size === 0) return at;
    }
  }
  const length = header(head, "content-length");
  if (length !== undefined) {
    const end = at + Number(length);
    return end <= buf.length ? end : null;
  }
  return null; // delimited by close
}

function header(head, name) {
  const line = head
    .split("\r\n")
    .slice(1)
    .find((l) => l.toLowerCase().startsWith(name + ":"));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
}

// Two sentinels, each spelled once: the tick that asks for the latest math,
// and the moderation value that hides a participant from the picture.
const LATEST = -1;
const HIDDEN = -1;

function requestBytes(method, target, headers, body) {
  let text = `${method} ${target} HTTP/1.1\r\n`;
  for (const [name, value] of headers) text += `${name}: ${value}\r\n`;
  return Buffer.concat([Buffer.from(text + "\r\n", "latin1"), body]);
}

const dateLine = /\r\nDate: [^\r]*\r\n/;
function sameButDate(a, b) {
  const ma = a.toString("latin1").match(dateLine);
  const mb = b.toString("latin1").match(dateLine);
  if (!ma || !mb || ma[0] === mb[0]) return false;
  return a.toString("latin1").replace(dateLine, "\r\n") === b.toString("latin1").replace(dateLine, "\r\n");
}

function parts(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, Math.max(0, headEnd)).toString("latin1");
  return { head, status: Number(head.split(" ")[1]), body: buf.subarray(headEnd + 4) };
}

let dateRetries = 0;
const records = [];
const results = [];
const cases = [];

async function reset(c) {
  const r = await fetch(`http://server:5001/begin?seed=${SEED}&case=${encodeURIComponent(c.id)}&clock=${c.clock}`);
  if (!r.ok) throw Error("entropy reset failed");
}

async function compare(c) {
  const bytes = requestBytes(c.method, c.target, c.headers, c.body);
  const headOnly = c.method === "HEAD";
  for (let attempt = 0; attempt < 5; attempt++) {
    await reset(c);
    const node = await exchange(NODE, bytes, headOnly);
    const n = parts(node);
    const record = { id: c.id, method: c.method, target: c.target, clock: c.clock, requester: c.requester, note: c.note, expectedServed: c.served, attempt, node: node.toString("base64"), nodeStatus: n.status };
    if (!header(n.head, "content-encoding") && !headOnly) record.nodeBody = n.body.toString("utf8");
    if (RECORD_ONLY) {
      records.push(record);
      return { id: c.id, equal: null, fallback: null, nodeStatus: n.status, statusMismatch: n.status !== c.status };
    }
    const rust = await exchange(RUST, bytes, headOnly);
    const r = parts(rust);
    const fallback = r.status === 502;
    const reason = fallback ? header(r.head, "x-polis-handback") : undefined;
    if (!fallback && !node.equals(rust) && sameButDate(node, rust)) {
      // Both servers have now seen this request once more; the sequence
      // stays the same on both sides.
      dateRetries++;
      continue;
    }
    const equal = node.equals(rust);
    Object.assign(record, { rust: rust.toString("base64"), fallback, reason, equal });
    records.push(record);
    const out = { id: c.id, fallback, equal, nodeStatus: n.status };
    if (n.status !== c.status) out.statusMismatch = true;
    if (c.served && fallback) Object.assign(out, { unexpectedFallback: true, reason });
    if (!c.served && !fallback) out.unexpectedServe = true;
    if (!c.served && fallback && reason !== c.reason) Object.assign(out, { wrongReason: true, reason, expectedReason: c.reason });
    if (!fallback && !equal) Object.assign(out, { node: node.toString("latin1"), rust: rust.toString("latin1") });
    return out;
  }
  throw Error(`${c.id}: Date differed five times`);
}

async function main() {
  const tokens = await fetch("http://server:5001/participant-read-tokens").then((r) => r.json());
  const oidc = await fetch("http://server:5001/tokens").then((r) => r.json());
  const { fixtures } = require("/app/characterization/comments-cases.cjs");
  const { databaseConvention, seedVote } = require("/app/characterization/seed-vote.cjs");
  const { Pool } = require("/app/node_modules/pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  if (new URL(process.env.DATABASE_URL).pathname !== "/p027") throw Error("disposable fixture database required");
  const agreeValue = await databaseConvention(pool);
  // Every valid choice is named by its meaning and stored through the fixture writer.
  const stored = (meaning) => seedVote(meaning, agreeValue);

  // Conversations nothing else in this run reads: one owner (uid 200001, pid 0),
  // uid 3 at pid 1 with a choice on each of the seven comments (tids 0..6),
  // and uids 2, 200004 and 4 at pids 2, 3 and 4 with none.
  const spare = fixtures.filter((f) => f.family === "dispatch" || f.family === "identity");
  const zero = fixtures.find((f) => f.shape === "content-edges");
  let nextSpare = 0;
  const take = () => {
    const f = spare[nextSpare++];
    if (!f) throw Error("out of spare fixture conversations");
    return f;
  };

  let clock = INSTANT + 100000;
  const step = (ms) => {
    clock += ms;
  };
  // Past Node's 30 s cache of a conversation's featured participant rows.
  const cold = () => step(30001);

  const who = (f) => ({
    anonymous: null,
    member: `Bearer ${tokens[`anonymous-${f.zid}`]}`, // uid 3
    standard: `Bearer ${tokens[`standard-${f.zid}`]}`, // uid 3
    second: `Bearer ${tokens[`unvoted-anonymous-${f.zid}`]}`, // uid 2
    externalToken: `Bearer ${tokens[`xid-${f.zid}`]}`, // uid 3, an external-id token
    owner: `Bearer ${oidc["comments-owner-1"]}`, // uid 200001
    moderator: `Bearer ${oidc["comments-moderator"]}`, // uid 200004
    admin: `Bearer ${oidc.admin}`, // uid 2
    outsider: `Bearer ${oidc.owner}`, // signed in, takes no part in these conversations
  });

  async function run(id, f, requester, o = {}) {
    const auth = o.auth !== undefined ? o.auth : who(f)[requester];
    const c = {
      id,
      clock,
      requester,
      note: o.note,
      method: o.method || "GET",
      target: o.target || `/api/v3/votes/famous?conversation_id=${f.capability}${o.tail || ""}`,
      served: o.reason === undefined,
      reason: o.reason,
      status: o.status || 200,
      headers: [["Host", "localhost"], ["Connection", "close"], ["X-Polis-Fixture-Clock", String(clock)], ...(auth ? [["Authorization", auth]] : []), ...(o.extra || [])],
      body: Buffer.from(o.body || ""),
    };
    if (cases.some((x) => x.id === id)) throw Error(`duplicate case ${id}`);
    cases.push(c);
    results.push(await compare(c));
  }

  // ---- fixture writers -------------------------------------------------
  let nextUid = 310000;
  async function account(label) {
    const uid = ++nextUid;
    await pool.query("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES($1,$2,$3,false,'p027-featured',$4)", [uid, `Generated ${label} ${uid}`, `featured-${uid}@example.invalid`, INSTANT]);
    return uid;
  }
  // External ids belong to an account (conversations.org_id), not to a
  // conversation, and every spare conversation has the same owner. Each group
  // therefore gets an account of its own, so one group's external ids are
  // never another's. Two people are kept clear of external ids until the last
  // groups, because an external id under ANY account makes the author of a
  // featured comment a featured participant: the owner and uid 3, who wrote
  // every comment here.
  async function open(f, anon = false) {
    const org = await account("account");
    await pool.query("UPDATE conversations SET is_anon=$2, org_id=$3 WHERE zid=$1", [f.zid, anon, org]);
    return org;
  }
  async function join(f) {
    const uid = await account("featured");
    const pid = (await pool.query("INSERT INTO participants(zid,uid,created) VALUES($1,$2,$3) RETURNING pid", [f.zid, uid, INSTANT])).rows[0].pid;
    return { uid, pid };
  }
  let castAt = INSTANT + 1000;
  // One row of history: a choice, named by its meaning.
  const cast = (f, pid, tid, meaning, created = ++castAt) => pool.query("INSERT INTO votes(zid,pid,tid,vote,created) VALUES($1,$2,$3,$4,$5)", [f.zid, pid, tid, stored(meaning), String(created)]);
  // Deliberately invalid storage, which no convention can express: no value
  // at all (null), or a number that is no choice. Node leaves the comment's
  // letter as it was. Never a valid choice; those go through `cast`.
  const NOT_A_CHOICE = 7;
  function corruptVoteFixture(f, pid, tid, value, created = ++castAt) {
    if (value !== null && value !== NOT_A_CHOICE) throw Error("a valid choice is written with cast");
    return pool.query("INSERT INTO votes(zid,pid,tid,vote,created) VALUES($1,$2,$3,$4,$5)", [f.zid, pid, tid, value, String(created)]);
  }
  const external = (org, uid, xid, url, name, email = null) => pool.query("INSERT INTO xids(owner,uid,xid,x_profile_image_url,x_name,x_email) VALUES($1,$2,$3,$4,$5,$6)", [org, uid, xid, url, name, email]);
  const moderate = (f, uid, mod) => pool.query("UPDATE participants SET mod=$3 WHERE zid=$1 AND uid=$2", [f.zid, uid, mod]);
  async function noMath(f) {
    for (const table of ["math_main", "math_bidtopid", "math_ptptstats", "math_ticks"]) await pool.query(`DELETE FROM ${table} WHERE zid=$1 AND math_env='p027'`, [f.zid]);
  }
  // `o.main` and `o.mapping` are the stored documents; a companion can be
  // left out or given another tick.
  async function math(f, tick, o) {
    await noMath(f);
    await pool.query("INSERT INTO math_main(zid,math_env,data,last_vote_timestamp,math_tick,caching_tick) VALUES($1,'p027',$2::jsonb,0,$3,$3)", [f.zid, JSON.stringify(o.main), tick]);
    if (o.mapping !== undefined) await pool.query("INSERT INTO math_bidtopid(zid,math_env,data,math_tick) VALUES($1,'p027',$2::jsonb,$3)", [f.zid, JSON.stringify(o.mapping), o.mappingTick ?? tick]);
    if (o.stats !== false) await pool.query("INSERT INTO math_ptptstats(zid,math_env,data,math_tick) VALUES($1,'p027','{}',$2)", [f.zid, tick]);
    // No caching_tick here: an installation older than the migrations has none on this table.
    if (o.ticks !== false) await pool.query("INSERT INTO math_ticks(zid,math_env,math_tick) VALUES($1,'p027',$2)", [f.zid, tick]);
  }
  const mainDoc = (o = {}) => ({
    math_tick: 999,
    n: 5,
    consensus: o.consensus,
    repness: o.repness,
    "base-clusters": o.base === undefined ? { id: [10, 11, 12, 13], x: [0, 1, 2, 3], y: [0, 1, 2, 3], count: [2, 2, 1, 1] } : o.base,
    "group-clusters": [{ id: 0, members: [10, 11], center: [0, 0] }, { id: 1, members: [12, 13], center: [3, 3] }],
    ...o.more,
  });

  try {
    // ---- A. An anonymous conversation: {} whoever asks -------------------
    {
      const f = take();
      // is_anon keeps the database default (true); the math is complete and
      // a participant has an external id.
      const org = await open(f, true);
      await cast(f, 2, 0, "agree");
      await external(org, 2, "anon-conversation-2", "https://example.invalid/p2.png", "Two");
      await math(f, 4, { main: mainDoc({ consensus: { agree: [{ tid: 0 }], disagree: [] }, repness: { 0: [{ tid: 1 }] } }), mapping: { bidToPid: [[0, 1], [2], [3], [4]] } });
      for (const requester of ["anonymous", "member", "standard", "second", "owner"]) await run(`anonymous-conversation/${requester}`, f, requester);
      await run("anonymous-conversation/member/head", f, "member", { method: "HEAD" });
      await run("anonymous-conversation/member/tick", f, "member", { tail: "&math_tick=4" });
      await noMath(f);
      step(3000);
      await run("anonymous-conversation/no-math/member", f, "member");
    }

    // ---- B. No math document ---------------------------------------------
    {
      const f = take();
      const org = await open(f);
      await run("no-math/cold/anonymous", f, "anonymous");
      await run("no-math/warm/member-after-anonymous", f, "member", { note: "the member's own row, within the 30 seconds of the rows the first request kept" });
      cold();
      await run("no-math/cold/member", f, "member");
      await run("no-math/warm/anonymous-after-member", f, "anonymous", { note: "a requester without a credential has no row of their own" });
      await run("no-math/warm/second-after-member", f, "second", { note: "as above, for a member without a vote" });
      cold();
      await run("no-math/cold/member-without-a-choice", f, "second");
      cold();
      await run("no-math/cold/standard", f, "standard");
      cold();
      await run("no-math/cold/owner", f, "owner");
      cold();
      await run("no-math/cold/outsider", f, "outsider");
      await cast(f, 2, 3, "disagree");
      await external(org, 2, "no-math-2", "https://example.invalid/p2.png", "Name & <b>2</b> \u{1F642}", "two@example.invalid");
      cold();
      await run("no-math/cold/member-with-external-id", f, "second", { tail: "&math_tick=1" });
      await run("no-math/warm/member-with-external-id/head", f, "second", { tail: "&math_tick=1", method: "HEAD" });
      await run("no-math/warm/member-sees-the-external-id-member", f, "member", { tail: "&math_tick=1", note: "the member's own row, with the rows kept for this tick" });
      await run("no-math/limit-zero", f, "second", { tail: "&ptptoiLimit=0" });
    }

    // ---- C. More featured participants than the default limit ------------
    {
      const f = take();
      const org = await open(f);
      const all = [];
      for (let i = 0; i < 40; i++) {
        const p = await join(f);
        all.push(p);
        await cast(f, p.pid, i % 7, ["agree", "disagree", "pass"][i % 3]);
        await external(org, p.uid, `many-${i}`, `https://example.invalid/many/${i}.png`, i % 5 ? `Participant ${i}` : null);
      }
      await math(f, 2, { main: mainDoc({ consensus: { agree: [], disagree: [] }, repness: {} }), mapping: { bidToPid: [[1, ...all.slice(0, 20).map((p) => p.pid)], all.slice(20, 30).map((p) => p.pid), all.slice(30, 38).map((p) => p.pid), []] } });
      await run("many/cold/default-limit/anonymous", f, "anonymous");
      cold();
      await run("many/cold/default-limit/member", f, "member");
      for (const coding of ["gzip", "deflate", "identity", "gzip, deflate", "*"]) await run(`many/warm/accept-encoding/${coding}`, f, "member", { extra: [["Accept-Encoding", coding]] });
      await run("many/warm/head/gzip", f, "member", { method: "HEAD", extra: [["Accept-Encoding", "gzip"]] });
      await run("many/limit/99", f, "member", { tail: "&ptptoiLimit=99" });
      await run("many/limit/99/gzip", f, "member", { tail: "&ptptoiLimit=99", extra: [["Accept-Encoding", "gzip"]] });
      await run("many/limit/31", f, "anonymous", { tail: "&ptptoiLimit=31" });
    }

    // ---- D. Histories of choices -----------------------------------------
    {
      const f = take();
      const org = await open(f);
      const other = await join(f);
      const late = await join(f);
      await external(org, other.uid, "history-other", "https://example.invalid/other.png", "Other");
      await external(org, late.uid, "history-late", "https://example.invalid/late.png", "Late");
      // No picture and no id, but an address: the fields nest, and the
      // address stays behind.
      const mail = await join(f);
      await external(org, mail.uid, "", "", "Address only", "mail@example.invalid");
      await cast(f, mail.pid, 2, "agree");
      // pid 1 already holds agree, pass, disagree, agree, pass, disagree, agree on tids 0..6.
      await cast(f, 1, 0, "disagree"); // changed twice: the last one stands
      await cast(f, 1, 0, "pass");
      await corruptVoteFixture(f, 1, 1, null); // no value stored after a pass: the pass stands
      await corruptVoteFixture(f, 1, 2, NOT_A_CHOICE); // a number that is no choice after a disagree: the disagree stands
      await corruptVoteFixture(f, 1, 12, null); // never anything but no value: unseen
      await corruptVoteFixture(f, 1, 15, NOT_A_CHOICE); // never anything but a number that is no choice: unseen
      await cast(f, 1, 20, "agree");
      await cast(f, other.pid, 3, "disagree");
      await cast(f, other.pid, 30, "pass");
      await math(f, 7, { main: mainDoc({ consensus: {}, repness: [] }), mapping: { bidToPid: [[1], [other.pid], [late.pid], [mail.pid]] } });
      await run("history/cold/member", f, "member");
      await run("history/warm/anonymous", f, "anonymous", { note: "the kept rows, and no row of the member's" });
      // A new choice at a higher tid, at the same tick: both servers answer
      // from the choices they cached, after the participant rows are read again.
      await cast(f, other.pid, 40, "agree");
      cold();
      await run("history/same-tick/cached-choices", f, "member");
      await run("history/newer-tick/read-again", f, "member", { tail: "&math_tick=8" });
      // A participant who appears later is read alone: the lengths differ.
      await cast(f, late.pid, 50, "disagree");
      cold();
      await run("history/same-tick/one-participant-read-alone", f, "member", { tail: "&math_tick=8" });
      await run("history/newer-tick/all-read-together", f, "member", { tail: "&math_tick=9" });
    }

    // ---- E. Cache boundaries ---------------------------------------------
    {
      const f = take();
      const org = await open(f);
      await cast(f, 2, 0, "agree");
      await external(org, 4, "bounds-4", "https://example.invalid/b4.png", "Four");
      await cast(f, 4, 1, "pass");
      const main = mainDoc({ consensus: { agree: [{ tid: 1 }] } });
      await math(f, 3, { main, mapping: { bidToPid: [[1], [2], [4], []] } });
      const first = clock;
      await run("bounds/rows/first/member", f, "member", { tail: "&math_tick=3" });
      clock = first + 30000;
      await run("bounds/rows/at-30000ms/second", f, "second", { tail: "&math_tick=3", note: "still the kept rows, with this requester's own row" });
      clock = first + 30001;
      await run("bounds/rows/at-30001ms/second", f, "second", { tail: "&math_tick=3", note: "read again" });
      await run("bounds/rows/same-limit-spelled-out/member", f, "member", { tail: "&math_tick=3&ptptoiLimit=30", note: "the default limit, spelled out: the same cached rows" });
      await run("bounds/rows/other-limit/member", f, "member", { tail: "&math_tick=3&ptptoiLimit=29", note: "another limit: other rows" });
      await run("bounds/rows/other-tick/member", f, "member", { tail: "&math_tick=2", note: "another tick: other rows" });
      // The math generation is kept three seconds.
      cold();
      const loaded = clock;
      await run("bounds/math/loaded", f, "member", { tail: "&math_tick=3" });
      await math(f, 4, { main, mapping: { bidToPid: [[4], [2], [1], []] } });
      clock = loaded + 2999;
      await run("bounds/math/at-2999ms", f, "member", { tail: "&math_tick=3", note: "the cached generation" });
      clock = loaded + 3000;
      await run("bounds/math/at-3000ms", f, "member", { tail: "&math_tick=3", note: "the new generation" });
    }

    // ---- F. States of the math document that are served ------------------
    {
      const f = take();
      const org = await open(f);
      await external(org, 2, "states-2", "https://example.invalid/s2.png", "Two");
      await cast(f, 2, 0, "agree");
      const mapping = { bidToPid: [[1], [2], [], []] };
      let tick = 20;
      const states = {
        "not-committed": [LATEST, { main: mainDoc({ consensus: { agree: [{ tid: 1 }] } }), mapping }],
        "tick-zero": [0, { main: mainDoc({ consensus: { agree: [{ tid: 1 }] } }), mapping }],
        "no-consensus-no-repness": [6, { main: mainDoc(), mapping }],
        "null-consensus-null-repness": [7, { main: mainDoc({ consensus: null, repness: null }), mapping }],
        "empty-lists": [8, { main: mainDoc({ consensus: { agree: [], disagree: [] }, repness: [] }), mapping }],
        "null-lists": [8, { main: mainDoc({ consensus: { agree: null, disagree: null }, repness: {} }), mapping }],
        "no-base-clusters": [9, { main: { ...mainDoc({ consensus: { agree: [{ tid: 3 }] } }), "base-clusters": undefined }, mapping }],
        "short-base-clusters": [10, { main: mainDoc({ base: { id: [10] } }), mapping }],
        "nobody-placed": [11, { main: mainDoc({ repness: { 0: [{ tid: 5 }, { tid: 3 }], 1: [] } }), mapping: { bidToPid: [] } }],
        "mapping-without-rows": [12, { main: mainDoc(), mapping: {} }],
      };
      for (const [name, [at, o]] of Object.entries(states)) {
        await math(f, at, o);
        cold();
        await run(`state/${name}/anonymous`, f, "anonymous", { tail: `&math_tick=${tick++}` });
        await run(`state/${name}/member`, f, "member", { tail: `&math_tick=${tick++}` });
      }
    }

    // ---- G. A complete math document, every kind of featured participant --
    {
      const f = take();
      const org = await open(f);
      const elsewhere = await account("account");
      const u = [];
      for (let i = 0; i < 8; i++) u.push(await join(f)); // pids 5..12
      await cast(f, 0, 0, "agree");
      await cast(f, 0, 2, "disagree");
      await cast(f, 2, 1, "agree");
      await cast(f, 2, 5, "pass");
      await cast(f, 3, 0, "disagree");
      await cast(f, 4, 3, "agree");
      await cast(f, u[0].pid, 0, "agree");
      await cast(f, u[0].pid, 9, "disagree");
      await cast(f, u[1].pid, 2, "pass");
      await cast(f, u[2].pid, 4, "agree");
      // u[3] makes no choice: never a featured participant.
      await cast(f, u[4].pid, 6, "agree");
      await cast(f, u[5].pid, 1, "disagree");
      await cast(f, u[6].pid, 5, "agree");
      await cast(f, u[7].pid, 6, "pass");
      await external(org, 2, "rich-2", "https://example.invalid/a2.png", "Name & <b>2</b> \u{1F642}", "two@example.invalid");
      await external(org, 4, "rich-4", "https://example.invalid/a4.png", null);
      await external(org, 200004, "rich-moderator", "", "Empty picture");
      await external(org, u[1].uid, "rich-u1", "https://example.invalid/u1.png", "Unplaced");
      await external(org, u[3].uid, "rich-u3", "https://example.invalid/u3.png", "No choice yet");
      await external(org, u[5].uid, "rich-u5", "https://example.invalid/u5.png", "Hidden");
      // Neither a picture nor an id nor an address: the row keeps its flat shape.
      await external(org, u[6].uid, "", "", "Flat \"name\" \\  ");
      // An external id under another account makes the owner a featured
      // author here, without any social field in this conversation.
      await external(elsewhere, f.owner, "elsewhere-owner", "https://example.invalid/elsewhere.png", "Elsewhere");
      await moderate(f, u[4].uid, 2);
      await moderate(f, u[7].uid, 3);
      await moderate(f, u[2].uid, 1);
      await moderate(f, u[5].uid, HIDDEN);
      const main = mainDoc({ consensus: { agree: [{ tid: 0, "n-success": 3 }], disagree: [{ tid: 6 }] }, repness: { 0: [{ tid: 1, repness: 1.5 }], 1: [{ tid: 2 }, { tid: 0 }] } });
      const mapping = { bidToPid: [[0, 1], [2, u[4].pid], [3, u[6].pid], [u[0].pid, u[7].pid]] };
      await math(f, 5, { main, mapping });
      for (const requester of ["anonymous", "member", "standard", "second", "owner", "moderator", "admin", "outsider"]) {
        cold();
        await run(`math/cold/${requester}`, f, requester);
      }
      cold();
      await run("math/cold/member/head", f, "member", { method: "HEAD" });
      cold();
      await run("math/cold/member/origin", f, "member", { extra: [["Origin", "https://example.invalid"]] });
      cold();
      await run("math/cold/member/if-none-match", f, "member", { extra: [["If-None-Match", "*"]], status: 304 });
      // The tick a client sends changes nothing in a cold process, and decides
      // which of Node's two caches answer in a warm one.
      cold();
      await run("math/tick/cold/current", f, "member", { tail: "&math_tick=5" });
      await run("math/tick/warm/stale", f, "member", { tail: "&math_tick=3", note: "an older tick than the cached one: cached choices" });
      await cast(f, 1, 9, "agree");
      await cast(f, 2, 0, "pass");
      await run("math/tick/warm/stale-after-new-choices", f, "member", { tail: "&math_tick=3", note: "Node's cached choices: the two new ones are missing" });
      await run("math/tick/warm/current-after-new-choices", f, "member", { tail: "&math_tick=5", note: "still cached at tick 5" });
      await run("math/tick/newer", f, "member", { tail: "&math_tick=9", note: "a newer tick than the cached one: read again" });
      await run("math/tick/warm/latest", f, "member", { tail: `&math_tick=${LATEST}` });
      await run("math/tick/warm/absent", f, "member");
      await run("math/tick/warm/absent/second", f, "second", { note: "a featured participant asks: their kept row is their own row" });
      await run("math/tick/large", f, "member", { tail: "&math_tick=9007199254740991" });
      await cast(f, 1, 11, "pass");
      await run("math/tick/after-large", f, "member", { tail: "&math_tick=12", note: "cached at the large tick: the new choice is missing" });
      // ptptoiLimit, each with its own cached rows.
      for (const limit of [0, 1, 2, 3, 4, 29, 99]) {
        await run(`math/limit/${limit}/member`, f, "member", { tail: `&ptptoiLimit=${limit}` });
        await run(`math/limit/${limit}/anonymous`, f, "anonymous", { tail: `&ptptoiLimit=${limit}&math_tick=5` });
      }
      // The request as the legacy participation client sends it (jQuery, with
      // its token): a content type on a GET without a body, max-age=0, and the
      // browser's own headers; then the browser's revalidation of that reply.
      const browser = [
        ["Accept", "application/json, text/javascript, */*; q=0.01"],
        ["Content-Type", "application/json; charset=utf-8"],
        ["Cache-Control", "max-age=0"],
        ["X-Requested-With", "XMLHttpRequest"],
        ["Accept-Encoding", "gzip, deflate, br"],
        ["Accept-Language", "en-US,en;q=0.9"],
        ["Origin", "https://localhost"],
        ["Referer", `https://localhost/${f.capability}`],
        ["User-Agent", "Mozilla/5.0 (generated fixture)"],
      ];
      cold();
      await run("math/client/first-poll", f, "member", { tail: `&math_tick=${LATEST}`, extra: browser });
      await run("math/client/next-poll", f, "member", { tail: "&math_tick=5", extra: browser });
      const sent = Buffer.from(records[records.length - 1].node, "base64").toString("latin1");
      const tag = header(sent.slice(0, sent.indexOf("\r\n\r\n")), "etag");
      if (!tag) throw Error("the reply to revalidate carries no entity tag");
      await run("math/client/revalidated", f, "member", { tail: "&math_tick=5", extra: [...browser, ["If-None-Match", tag]], status: 304 });
      await run("math/client/revalidated-with-another-tag", f, "member", { tail: "&math_tick=5", extra: [...browser, ["If-None-Match", 'W/"0-none"']] });
      // What the client adds for a participant who came with an external id.
      await run("handback/client/external-id-parameters", f, "member", { tail: "&math_tick=5&xid=someone&x_name=Some%20One&x_profile_image_url=https%3A%2F%2Fexample.invalid%2Fp.png", extra: browser, reason: "request" });
      // A closed conversation is read the same way.
      await pool.query("UPDATE conversations SET is_active=false WHERE zid=$1", [f.zid]);
      cold();
      await run("math/closed/member", f, "member");
      await pool.query("UPDATE conversations SET is_active=true WHERE zid=$1", [f.zid]);
    }

    // ---- H. What goes back to Node ---------------------------------------
    {
      // States of the math document, on a conversation of their own: Node
      // answers these and fills its caches, polis-api does not.
      const f = take();
      const org = await open(f);
      await external(org, 2, "handback-2", "https://example.invalid/h2.png", "Two");
      await cast(f, 2, 0, "agree");
      const mapping = { bidToPid: [[1], [2], [], []] };
      const good = mainDoc({ consensus: { agree: [{ tid: 1 }] } });
      const states = {
        "mapping-at-another-tick": [{ main: good, mapping, mappingTick: 31 }, "math_incoherent", 200],
        "no-participant-statistics": [{ main: good, mapping, stats: false }, "math_incoherent", 200],
        "no-tick-row": [{ main: good, mapping, ticks: false }, "math_incoherent", 200],
        "no-mapping": [{ main: good }, "math_incoherent", 200],
        "oversized": [{ main: { ...good, padding: "x".repeat(70000) }, mapping }, "math_unreadable", 200],
        "malformed-mapping-row": [{ main: good, mapping: { bidToPid: [[1], "invalid"] } }, "math_unreadable", 200],
        "consensus-tid-missing": [{ main: mainDoc({ consensus: { agree: [{ tid: 1 }, {}] } }), mapping }, "math_shape", 500],
        "consensus-tid-null": [{ main: mainDoc({ consensus: { agree: [{ tid: null }] } }), mapping }, "math_shape", 500],
        "consensus-tid-text": [{ main: mainDoc({ consensus: { disagree: [{ tid: "2" }] } }), mapping }, "math_shape", 200],
        "consensus-not-an-object": [{ main: mainDoc({ consensus: [{ tid: 1 }] }), mapping }, "math_shape", 200],
        "repness-list-of-numbers": [{ main: mainDoc({ repness: [1, 2] }), mapping }, "math_shape", 200],
        "repness-group-not-a-list": [{ main: mainDoc({ repness: { 0: { tid: 1 } } }), mapping }, "math_shape", 200],
        "repness-tid-missing": [{ main: mainDoc({ repness: { 0: [{ repness: 2 }] } }), mapping }, "math_shape", 500],
      };
      let tick = 40;
      for (const [name, [o, reason, status]] of Object.entries(states)) {
        await math(f, 30, o);
        cold();
        await run(`handback/math/${name}`, f, "member", { tail: `&math_tick=${tick++}`, reason, status });
      }
    }
    {
      // Requests, on a conversation of their own for the same reason.
      const f = take();
      await open(f);
      await math(f, 1, { main: mainDoc({ consensus: { agree: [{ tid: 1 }] } }), mapping: { bidToPid: [[1], [], [], []] } });
      const base = `/api/v3/votes/famous?conversation_id=${f.capability}`;
      await run("handback/external-id-token", f, "externalToken", { reason: "identity" });
      await run("handback/malformed-token", f, null, { auth: "Bearer malformed", reason: "identity", status: 401 });
      await run("handback/basic-credential", f, null, { auth: "Basic Zml4dHVyZTpmaXh0dXJl", reason: "identity" });
      await run("handback/cookie", f, "anonymous", { extra: [["Cookie", "fixture=1"]], reason: "request" });
      await run("handback/body", f, "anonymous", { extra: [["Content-Type", "application/json"], ["Content-Length", "2"]], body: "{}", reason: "request" });
      for (const method of ["POST", "PUT", "DELETE"]) await run(`handback/method/${method}`, f, "anonymous", { method, reason: "request", status: 404 });
      await run("handback/method/OPTIONS", f, "anonymous", { method: "OPTIONS", reason: "request", status: 204 });
      for (const [name, tail, status] of [
        ["unknown-parameter", "&unknown=1", 200],
        ["repeated-conversation", "&conversation_id=other", 400],
        ["repeated-tick", "&math_tick=1&math_tick=2", 400],
        ["tick-text", "&math_tick=abc", 400],
        ["tick-empty", "&math_tick=", 400],
        ["tick-decimal", "&math_tick=1.5", 200],
        ["tick-leading-zero", "&math_tick=01", 200],
        ["tick-plus", "&math_tick=%2B1", 200],
        ["tick-spaces", "&math_tick=%201", 200],
        ["tick-suffix", "&math_tick=1x", 200],
        ["tick-beyond-exact-integers", "&math_tick=9007199254740993", 200],
        ["limit-text", "&ptptoiLimit=many", 400],
        ["limit-100", "&ptptoiLimit=100", 400],
        ["limit-negative", "&ptptoiLimit=-5", 400],
        ["limit-leading-zero", "&ptptoiLimit=05", 200],
        ["limit-decimal", "&ptptoiLimit=2.5", 200],
        ["pid", "&pid=0", 200],
        ["uid", "&uid=3", 200],
      ]) await run(`handback/parameter/${name}`, f, "anonymous", { tail, reason: "request", status });
      await run("handback/conversation/missing", f, "anonymous", { target: "/api/v3/votes/famous", reason: "request", status: 400 });
      await run("handback/conversation/empty", f, "anonymous", { target: "/api/v3/votes/famous?conversation_id=", reason: "request", status: 400 });
      await run("handback/conversation/unknown", f, "anonymous", { target: "/api/v3/votes/famous?conversation_id=absentfixture", reason: "conversation", status: 400 });
      await run("handback/conversation/unknown/member", f, "member", { target: "/api/v3/votes/famous?conversation_id=absentfixture", reason: "identity", status: 400 });
      await run("handback/conversation/trailing-space", f, "anonymous", { target: `${base}%20`, reason: "request" });
      await run("handback/token-of-another-conversation", f, null, { auth: `Bearer ${tokens[`anonymous-${zero.zid}`]}`, reason: "identity" });
    }
    {
      // Tokens the fixture issuer makes only for this conversation.
      const f = zero;
      await open(f);
      for (const [name, status] of [["missing", 200], ["wrongPid", 200], ["expired", 401], ["wrongIssuer", 401], ["wrongAudience", 401], ["tampered", 401]]) await run(`handback/token/${name}`, f, null, { auth: `Bearer ${tokens[name]}`, reason: "identity", status });
      // A token that is not valid yet, asked before the second it starts at.
      const resume = clock;
      clock = INSTANT + 5000;
      await run("handback/token/future", f, null, { auth: `Bearer ${tokens.future}`, reason: "identity", status: 401 });
      clock = resume;
    }
    {
      // A conversation whose is_anon is NULL is not anonymous.
      const f = take();
      await open(f);
      await pool.query("UPDATE conversations SET is_anon=NULL WHERE zid=$1", [f.zid]);
      await run("null-anonymity/member", f, "member");
      // A conversation with no account for external ids.
      await pool.query("UPDATE conversations SET org_id=NULL WHERE zid=$1", [f.zid]);
      cold();
      await run("no-account/member", f, "member");
    }

    // ---- I. The requester's own external id, last: from here on uid 3 is a
    // featured author wherever a comment of theirs is featured ----------------
    {
      const f = take();
      const org = await open(f);
      await cast(f, 2, 0, "agree");
      await math(f, 6, { main: mainDoc({ consensus: { agree: [{ tid: 1 }] }, repness: { 0: [{ tid: 3 }] } }), mapping: { bidToPid: [[1], [2], [], []] } });
      await run("own-external-id/before/anonymous", f, "anonymous", { tail: "&math_tick=1" });
      await external(org, 3, "own-3", "https://example.invalid/own3.png", "Own é 三", "three@example.invalid");
      cold();
      await run("own-external-id/anonymous", f, "anonymous", { note: "a featured author with an external id" });
      cold();
      await run("own-external-id/member", f, "member");
      cold();
      await run("own-external-id/second", f, "second");
      // Two external ids of one person under one account (the table is unique
      // on the account and the id, not on the person): Node keeps whichever
      // row the database returns last.
      await external(org, 3, "own-3-again", "https://example.invalid/again.png", "Again");
      cold();
      await run("handback/two-external-id-rows", f, "member", { reason: "ambiguous_rows" });
    }

    // ---- J. The requester's own row, decided for each request -------------
    {
      const f = take();
      const org = await open(f);
      // Six featured participants: five generated ones with an external id,
      // the last of them also a moderator's pin, and uid 2. Nothing features
      // uid 3 (the member) or the owner here: no comment is featured.
      const g = [];
      for (let i = 0; i < 5; i++) {
        const p = await join(f);
        g.push(p);
        await cast(f, p.pid, i, ["agree", "disagree", "pass"][i % 3]);
        await external(org, p.uid, `own-row-${i}`, `https://example.invalid/own-row/${i}.png`, `Featured ${i}`);
      }
      await moderate(f, g[4].uid, 2);
      await cast(f, 2, 0, "agree");
      await external(org, 2, "own-row-second", "https://example.invalid/own-row/second.png", "Second");
      await math(f, 8, { main: mainDoc({ consensus: { agree: [], disagree: [] }, repness: {} }), mapping: { bidToPid: [[0, 1, 2, 3, 4], g.map((p) => p.pid), [], []] } });
      cold();
      const at = "&math_tick=70";
      await run("own-row/member/first", f, "member", { tail: at, note: "the member's own row and the six featured participants" });
      await run("own-row/anonymous/within", f, "anonymous", { tail: at, note: "the six featured participants, nobody marked" });
      await run("own-row/featured/within", f, "second", { tail: at, note: "a featured participant asks: their kept row is their own row" });
      await run("own-row/owner-without-a-vote/within", f, "owner", { tail: at, note: "a participant without a vote has no row of their own" });
      await run("own-row/outsider/within", f, "outsider", { tail: at, note: "an account that takes no part has no row of its own" });
      await run("own-row/member/again", f, "member", { tail: at, note: "the bytes of the member's first reply" });
      // Three places, and three featured participants kept for them.
      const three = `${at}&ptptoiLimit=3`;
      await run("own-row/limit/anonymous/first", f, "anonymous", { tail: three });
      await run("own-row/limit/member/within", f, "member", { tail: three, note: "the member takes the first place; the last of the ranking gives up its own" });
      await run("own-row/limit/featured/within", f, "second", { tail: three, note: "one of the three asks: nobody gives up a place" });
      // One place, kept for the pin: a featured participant beyond the limit.
      const one = `${at}&ptptoiLimit=1`;
      await run("own-row/limit-one/anonymous/first", f, "anonymous", { tail: one });
      await run("own-row/limit-one/featured-beyond-the-limit", f, "second", { tail: one, note: "their own row, read for them, takes the one place" });
      await run("own-row/limit-one/anonymous/again", f, "anonymous", { tail: one });
      // A first vote shows in the voter's own row at once, within the 30
      // seconds of the kept rows, and in nobody else's reply.
      await run("own-row/before-a-first-vote/moderator", f, "moderator", { tail: at });
      await cast(f, 3, 1, "pass");
      await run("own-row/after-a-first-vote/moderator/within", f, "moderator", { tail: at, note: "the voter's own row, within the 30 seconds of the kept rows" });
      await run("own-row/after-a-first-vote/anonymous/within", f, "anonymous", { tail: at });
    }

    if (new Set(cases.map((c) => c.id)).size !== cases.length) throw Error("case names must be unique");
    if (RECORD_ONLY) {
      fs.writeFileSync("/artifacts/votes-famous-node.json", JSON.stringify({ format: 1, source: "direct unchanged Node listener; generated fixtures; complete HTTP bytes", records }, null, 2) + "\n");
      const wrong = results.filter((r) => r.statusMismatch);
      console.log(JSON.stringify({ recorded: cases.length, byStatus: results.reduce((o, r) => ((o[r.nodeStatus] = (o[r.nodeStatus] || 0) + 1), o), {}), unexpectedStatus: wrong }, null, 2));
      if (wrong.length) process.exitCode = 1;
      return;
    }
    let off = 0;
    for (const c of cases) {
      const response = await exchange({ host: "polis-api-off", port: 5100 }, requestBytes(c.method, c.target, c.headers, c.body), c.method === "HEAD");
      if (!response.toString("latin1").startsWith("HTTP/1.1 502")) throw Error(`off switch served ${c.id}`);
      off++;
    }
    fs.writeFileSync("/artifacts/votes-famous-recordings.json", JSON.stringify({ format: 1, source: "direct unchanged Node listener and polis-api; generated fixtures; complete HTTP bytes", records }, null, 2) + "\n");
    const differences = results.filter((r) => r.unexpectedFallback || r.unexpectedServe || r.wrongReason || r.statusMismatch || (!r.fallback && !r.equal));
    const counters = await fetch("http://polis-api:5100/health").then((r) => r.json());
    const handbacks = results.filter((r) => r.fallback);
    const summary = {
      cases: cases.length,
      servedByRust: results.filter((r) => !r.fallback).length,
      exact: results.filter((r) => r.equal).length,
      handedToNode: handbacks.length,
      handbackReasons: records.filter((r) => r.fallback).reduce((o, r) => ((o[r.reason] = (o[r.reason] || 0) + 1), o), {}),
      off,
      dateRetries,
      differences,
      counters: { votesFamousServed: counters.votesFamousServed, votesFamousFallback: counters.votesFamousFallback, votesFamousHandbacks: counters.votesFamousHandbacks },
    };
    if (counters.votesFamousServed !== summary.servedByRust + dateRetries || counters.votesFamousFallback !== summary.handedToNode) summary.counterMismatch = true;
    console.log(JSON.stringify(summary, null, 2));
    if (differences.length || summary.counterMismatch || !summary.exact) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 2;
});
