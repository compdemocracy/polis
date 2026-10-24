"use strict";
// The comments recorder's foreign actor needs an owned conversation. Vote
// reads do not need the separate math-seed campaign's tables or PCA outputs.
const {Pool}=require("/app/node_modules/pg");
const {actors}=require("/app/characterization/comments-cases.cjs");
async function main() {
  if(new URL(process.env.DATABASE_URL).pathname!=="/p027")throw Error("disposable fixture database required");
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const actor=actors.find(a=>a.ref==="comments-foreign");
  try {
    await pool.query("INSERT INTO users(uid,hname,email,is_owner,site_id,created) VALUES($1,'Generated foreign owner','foreign@example.invalid',true,$2,1700000000000)",[actor.uid,actor.site]);
    await pool.query("INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,created,modified) VALUES(900,$1,'Foreign fixture',true,false,true,1700000000000,1700000000000)",[actor.uid]);
  } finally {await pool.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
