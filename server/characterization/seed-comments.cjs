"use strict";
const { fixtures, actors } = require("./comments-cases.cjs");
const { hash } = require("./core.cjs");
const CLOCK = 1700000000000;
// Public-fixture INPUT rows only. Response bodies are always produced by the real app.
function rows(f) {
  const shape = f.shape,
    r = f.replicate;
  let n =
    shape === "empty"
      ? 0
      : shape.startsWith("cap-")
      ? Number(shape.slice(4))
      : shape.startsWith("small-")
      ? 1
      : shape.startsWith("large-")
      ? 12 + r
      : 6 + r;
  const out = [];
  for (let i = 0; i < n; i++) {
    const edge = shape === "content-edges";
    let row = {
      tid: i,
      txt: edge
        ? `生成 café "quote" \\ slash\nrow ${f.zid}/${i}`
        : `Generated ${f.zid}/${i}${
            shape.startsWith("large-") ? " x".repeat(90) : ""
          }`,
      pid: i % 2,
      uid: i % 2 === f.participantPid ? 3 : f.owner,
      created: String(
        CLOCK + f.zid * 1000 + (shape === "tied-created" ? 0 : i)
      ),
      mod: 1,
      active: true,
      velocity: 1,
      quote_src_url: edge && i % 2 ? "https://example.invalid/generated" : null,
      is_seed: i % 2 === 0,
      is_meta: i % 3 === 0,
      lang: edge ? (i % 2 ? "ja" : null) : "en",
      original_id:
        edge && i % 2
          ? `00000000-0000-4000-8000-${(f.zid * 100 + i)
              .toString()
              .padStart(12, "0")}`
          : null,
    };
    if (shape === "hidden-strict-off") row.mod = -1;
    if (shape === "hidden-strict-on") row.mod = 0;
    if (shape === "mix-strict-off" || shape === "mix-strict-on")
      row.mod = [-1, 0, 1][i % 3];
    if (shape === "inactive-mix" && i % 2) row.active = false;
    if (shape === "velocity-mix") row.velocity = [0, -1, 1][i % 3];
    out.push(row);
  }
  // Fixed eligible cap; extra hidden inputs and text/clock differ across replicas.
  if (shape.startsWith("cap-"))
    for (let j = 0; j < r; j++)
      out.push({
        ...out[0],
        tid: n + j,
        txt: `Generated hidden ${f.zid}/${j}`,
        mod: -1,
      });
  if (shape === "tied-created" && r === 2) out.reverse();
  if (shape === "tied-created" && r === 3) out.push(out.shift());
  return out;
}
async function seedComments(pool, tokens) {
  const evidence = [];
  for (const a of actors) {
    if (a.uid !== 4)
      await pool.query(
        "INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES($1,$2,$3,true,$4,$5)",
        [a.uid, `Generated ${a.ref}`, `${a.ref}@example.invalid`, a.site, CLOCK]
      );
    if (a.uid === 4) {
      const existing = (
        await pool.query(
          "select u.site_id,exists(select 1 from conversations where owner=u.uid) as owns from users u where uid=4"
        )
      ).rows;
      if (
        existing.length !== 1 ||
        existing[0].site_id !== a.site ||
        !existing[0].owns
      )
        throw Error("foreign owner must own a generated conversation");
    }
    const claims = JSON.parse(
      Buffer.from(tokens[a.ref].split(".")[1], "base64url")
    );
    await pool.query(
      "INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,$3)",
      [claims.sub, a.uid, CLOCK]
    );
  }
  for (const f of fixtures) {
    const comments = rows(f),
      uids = f.participantPid === 0 ? [3, f.owner] : [f.owner, 3];
    // Vary participant counts without changing the bound PID dimension.
    uids.push(
      2,
      200004,
      4,
      ...[200001, 200002, 200003]
        .filter((u) => u !== f.owner)
        .slice(0, f.replicate - 1)
    );
    await pool.query(
      "INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter,strict_moderation,created,modified) VALUES($1,$2,$3,true,false,true,false,false,$4,$5,$5)",
      [
        f.zid,
        f.owner,
        `Generated comments ${f.key}`,
        f.strict,
        CLOCK + f.zid * 1000,
      ]
    );
    await pool.query(
      "INSERT INTO zinvites(zid,zinvite,uuid,created) VALUES($1,$2,$3,$4)",
      [
        f.zid,
        f.capability,
        `00000000-0000-4000-8000-${String(f.zid).padStart(12, "0")}`,
        CLOCK,
      ]
    );
    await pool.query(
      "INSERT INTO reports(zid,report_id,created,modified) VALUES($1,$2,$3,$3)",
      [f.zid, f.report, CLOCK]
    );
    for (const uid of uids)
      await pool.query(
        "INSERT INTO participants(zid,uid,created) VALUES($1,$2,$3)",
        [f.zid, uid, CLOCK]
      );
    // The DB trigger assigns tids in actual insertion order, including tied-created variants.
    await pool.query(
      `INSERT INTO comments(zid,tid,pid,uid,txt,created,modified,mod,active,velocity,quote_src_url,is_seed,is_meta,lang,original_id)
    SELECT $1,x.tid,x.pid,x.uid,x.txt,x.created::bigint,x.created::bigint,x.mod,x.active,x.velocity,x.quote_src_url,x.is_seed,x.is_meta,x.lang,x.original_id::uuid
    FROM jsonb_to_recordset($2::jsonb) AS x(tid int,pid int,uid int,txt text,created text,mod int,active boolean,velocity real,quote_src_url text,is_seed boolean,is_meta boolean,lang text,original_id text)`,
      [f.zid, JSON.stringify(comments)]
    );
    await pool.query(
      `INSERT INTO votes(zid,pid,tid,vote,created) SELECT zid,$2,tid,CASE tid%3 WHEN 0 THEN -1 WHEN 1 THEN 0 ELSE 1 END,$3 FROM comments WHERE zid=$1`,
      [f.zid, f.participantPid, CLOCK]
    );
    const actual = (
      await pool.query(
        "SELECT tid,pid,uid,txt,created,mod,active,velocity,quote_src_url,is_seed,is_meta,lang,original_id FROM comments WHERE zid=$1 ORDER BY tid",
        [f.zid]
      )
    ).rows;
    const votes = (
      await pool.query(
        "SELECT pid,tid,vote,created FROM votes WHERE zid=$1 ORDER BY tid",
        [f.zid]
      )
    ).rows;
    const visible = actual.filter(
      (c) =>
        c.active && c.velocity > 0 && (f.strict ? c.mod === 1 : c.mod !== -1)
    );
    evidence.push({
      ...f,
      commentCount: actual.length,
      participantCount: uids.length,
      voteCount: votes.length,
      inputSha256: hash({ fixture: f, comments: actual, votes }),
      eligibleCount: visible.length,
      expectedCount: Math.min(999, visible.length),
      expectedTids: visible
        .sort((a, b) => Number(a.created) - Number(b.created))
        .slice(0, 999)
        .map((c) => c.tid),
    });
  }
  await pool.query(
    "SELECT setval('users_uid_seq',(SELECT max(uid) FROM users)),setval('conversations_zid_seq',(SELECT max(zid) FROM conversations))"
  );
  return {
    clock: CLOCK,
    actors: actors.map(({ username: _username, ...a }) => a),
    fixtures: evidence,
  };
}
module.exports = { rows, seedComments };
