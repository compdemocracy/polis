"use strict";
// The user-read corpus needs a foreign owner but no math output.
const { Pool } = require("/app/node_modules/pg");
async function main() {
  if (new URL(process.env.DATABASE_URL).hostname !== "postgres" || new URL(process.env.DATABASE_URL).pathname !== "/p027") throw Error("isolated fixture database required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES(4,'Generated foreign owner','foreign@example.invalid',true,'p027r4-foreign',1700000000000)");
    await pool.query("INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public) VALUES(950,4,'Generated foreign user-read fixture',true,false,true)");
  } finally { await pool.end(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
