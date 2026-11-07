"use strict";
// The comments corpus expects a foreign owner normally supplied by the math
// corpus. Create only that actor and an empty conversation: no math is seeded.
const {Client} = require("/app/node_modules/pg");
const rejectedModeration = -1;
async function main() {
  const c = new Client({connectionString:process.env.DATABASE_URL});
  if (new URL(process.env.DATABASE_URL).pathname !== "/p027") throw Error("disposable p027 database required");
  await c.connect();
  try {
    if (process.argv[2] === "analyze") {
      // Finish fixture statistics before comparing unordered reads. Otherwise
      // autovacuum can change the join plan between the paired requests.
      await c.query("ANALYZE comments, votes, votes_latest_unique, conversations, reports, users, participants, zinvites, oidc_user_mappings");
      const plans = {};
      for (const [name, columns] of [["node", "*"], ["rust", "*"]]) {
        const sql = `select ${columns} from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1) and comments.active = true and comments.velocity > 0 and comments.mod != ($2)`;
        plans[name] = (await c.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, [1024, rejectedModeration])).rows;
      }
      require("node:fs").writeFileSync("/artifacts/report-comments-plans.json", JSON.stringify(plans, null, 2));
      return;
    }
    await c.query("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES(4,'Generated foreign owner','foreign@example.invalid',true,'p027r4-foreign',1700000000000)");
    await c.query("INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter,created,modified) VALUES(900,4,'Generated foreign conversation',true,false,true,false,false,1700000000000,1700000000000)");
  } finally { await c.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
