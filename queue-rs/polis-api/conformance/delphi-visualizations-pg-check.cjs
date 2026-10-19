"use strict";
const fs = require("node:fs");
const path = require("node:path");
exports.start = async function({keys,jwks,publicKey,request,serialize,oidc,database}) {
  const {createRequire}=require("node:module");
  const {Client}=createRequire(path.resolve(process.cwd(),"package.json"))("pg");
  const permissions=new Client({connectionString:database});await permissions.connect();
  await permissions.query("CREATE ROLE generated_logs_reader LOGIN; GRANT polis_queue_executor TO generated_logs_reader");
  await permissions.query("CREATE ROLE generated_viz_reader LOGIN; GRANT SELECT ON ALL TABLES IN SCHEMA public TO generated_viz_reader");
  await permissions.end();
  fs.mkdirSync(keys,{recursive:true});
  fs.writeFileSync(path.join(keys,"jwks.json"),JSON.stringify(jwks));
  fs.writeFileSync(path.join(keys,"participant.pem"),publicKey);
  fs.writeFileSync(path.join(keys,"ready"),"ready\n");
  const port=Number(process.env.P2ZERO_RUST_PORT||5100);
  let ready=false;
  for(let i=0;i<120;i++) {
    try { const r=await request("/health",null,port); if(r.status===200){ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready) throw Error("Rust visualization readiness deadline");
  const captures=[];
  const handoffs=[];
  return {
    matches(c) { return ["GET /api/v3/delphi/logs", "GET /api/v3/delphi/visualizations"].includes(c.route); },
    async compare(c,token,node) {
      const r=await request(c.path,token,port);
      const rust=serialize(c,r);
      captures.push({case:c.id,node:JSON.parse(node),rust:JSON.parse(rust),equal:node===rust});
    },
    async finish() {
      // Native rows and attempts use the release SQL, after the baseline reads.
      // No worker or model runs, and no vote is inserted by this fixture.
      const {createRequire}=require("node:module");
      const {Client}=createRequire(path.resolve(process.cwd(),"package.json"))("pg");
      const db=new Client({connectionString:database}); await db.connect();
      const owner=oidc("p2zero|owner","owner@example.invalid");
      const other=oidc("p2zero|other","other@example.invalid");
      async function check(id,query,token,status,verify) {
        const c={id:`supplemental/${id}`,state:"supplemental",route:"GET "+query.split("?")[0],path:query,auth:token===owner?"owner":token===other?"other":token?"moderator":"none"};
        const n=await request(query,token);const r=await request(query,token,port);
        const node=serialize(c,n),rust=serialize(c,r);
        if(n.status!==status) throw Error(`${id}: fixture Node status ${n.status}, want ${status}`);
        if(verify)verify(JSON.parse(n.body));
        captures.push({case:c.id,node:JSON.parse(node),rust:JSON.parse(rust),equal:node===rust});
      }
      const job="00000000-0000-4000-8000-00000000f001";
      const run="00000000-0000-4000-8000-00000000f002";
      const attempt="00000000-0000-4000-8000-00000000f003";
      const worker="00000000-0000-4000-8000-00000000f004";
      const query=`/api/v3/delphi/logs?job_id=${job}`;
      await db.query("SELECT pd_writer_admit('p2zero',105,'delphi','generated-logs','native-logs',repeat('a',64),$1,$2,'delphi_full_pipeline',NULL,'{}',repeat('b',40))",[job,run]);
      await check("native-no-attempt",query,owner,200,b=>{if(b.length)throw Error("expected no attempt logs");});
      const q=(await db.query("SELECT priority,worker_class FROM polis_queue_jobs WHERE env='p2zero' AND job_id=$1",[job])).rows[0];
      const claim=(await db.query("SELECT pq_claim('p2zero',$1::smallint,$2::uuid,$3::uuid,900,$4::text) AS claim",[q.priority,worker,attempt,q.worker_class])).rows[0].claim;
      if(claim.job_id!==job)throw Error("native claim was not the generated job");
      await db.query(`INSERT INTO polis_queue_logs(env,attempt_id,seq,ts,stream,line) VALUES
        ('p2zero',$1,1,'2023-11-14T20:21:00.123456Z','stdout','generated stdout'),
        ('p2zero',$1,2,'2023-11-14T20:21:01Z','manifest','{}'),
        ('p2zero',$1,3,'2023-11-14T20:21:02.999999Z','stderr','generated stderr'),
        ('p2zero',$1,4,'2023-11-14T20:21:03Z','truncated','generated truncation')`,[attempt]);
      await check("native-streams",query,owner,200,b=>{if(b.length!==2||b[0].timestamp!==1699993260123||!b[1].message.includes("ERROR: generated stderr"))throw Error("native stream fixture");});
      await check("native-foreign-owner",query,other,403);
      await check("native-no-token",query,null,401);
      await check("missing-job-id","/api/v3/delphi/logs",owner,400);
      // Limit is applied before stdout/stderr filtering, not after it.
      await db.query("INSERT INTO polis_queue_logs(env,attempt_id,seq,ts,stream,line) SELECT 'p2zero',$1,i,'2023-11-14T20:21:04Z','manifest','{}' FROM generate_series(5,1000) i",[attempt]);
      await db.query("INSERT INTO polis_queue_logs(env,attempt_id,seq,ts,stream,line) VALUES('p2zero',$1,1001,'2023-11-14T20:21:05Z','stdout','must not appear')",[attempt]);
      await check("native-limit-before-filter",query,owner,200,b=>{if(b.length!==2)throw Error("first 1000 then filter");});
      await db.query("INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES('p2zero|admin',2)");
      await check("native-admin",query,oidc("p2zero|admin","admin@example.invalid"),200);
      await db.query("INSERT INTO users(uid,hname,email,is_owner,site_id) VALUES(200,'Generated Site Moderator','sitemod@example.invalid',true,'p2zero-owner'); INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES('p2zero|sitemod',200)");
      await check("native-site-moderator",query,oidc("p2zero|sitemod","sitemod@example.invalid"),200);
      const archived="00000068-0000-4000-8000-000000000001";
      await db.query("SELECT pd_writer_admit('p2zero',104,'delphi','generated-logs','archive-precedence',repeat('c',64),$1,gen_random_uuid(),'delphi_full_pipeline',NULL,'{}',repeat('b',40))",[archived]);
      await check("active-row-hides-archive",`/api/v3/delphi/logs?job_id=${archived}`,owner,200,b=>{if(b.length)throw Error("active row did not hide historical logs");});
      const viz="/api/v3/delphi/visualizations?report_id=r2p2zero105";
      await check("visualizations-native-and-archive",viz,null,200,b=>{if(!b.jobs.some(j=>j.jobId===job&&j.workLive===true)||!b.jobs.some(j=>j.archived===true&&j.workLive===false))throw Error("mixed jobs fixture");});
      await check("visualizations-native-filter",`${viz}&job_id=${job}`,null,200,b=>{if(b.jobs.length!==1||b.jobs[0].jobId!==job)throw Error("job filter");});
      await check("visualizations-unknown-filter",`${viz}&job_id=generated-unknown-job`,null,200,b=>{if(b.jobs.length)throw Error("unknown job filter");});
      await check("visualizations-authorization-is-ignored",viz,other,200);
      await db.query("SELECT pq_fail('p2zero',$1::uuid,$2::uuid,$3::uuid,$4::bigint,true,'stage_failed',true)",[job,worker,attempt,claim.lease_epoch]);
      await check("visualizations-terminal-confirmed",`${viz}&job_id=${job}`,null,200,b=>{if(b.jobs.length!==1||b.jobs[0].workLive!==false||b.jobs[0].status!=="FAILED")throw Error("terminal job fixture");});
      await db.query("UPDATE polis_queue_logs SET line=repeat('x',600000) WHERE env='p2zero' AND attempt_id=$1 AND seq IN (1,3)",[attempt]);
      const oversized=await request(query,owner,port);
      const nodeOversized=await request(query,owner);
      if(oversized.status!==502||nodeOversized.status!==200||nodeOversized.body.length<=1024*1024)throw Error("native input cap does not hand back complete logs");
      handoffs.push({case:"native-input-cap",rustStatus:oversized.status,nodeStatus:nodeOversized.status,nodeBytes:nodeOversized.body.length});
      // Only the later liveness statement needs this table. Force that
      // statement to fail while the initial metadata snapshot still succeeds.
      await db.query("REVOKE SELECT ON public.delphi_provider_requests FROM generated_viz_reader");
      const liveNode=await request(`${viz}&job_id=${job}`,null);
      const liveRust=await request(`${viz}&job_id=${job}`,null,port);
      const livenessFailure={case:"liveness-query-failure",nodeStatus:liveNode.status,rustStatus:liveRust.status,nodeBody:JSON.parse(liveNode.body),rustBody:liveRust.body};
      fs.writeFileSync(path.join(keys,"liveness-failure.json"),JSON.stringify(livenessFailure,null,2)+"\n");
      await db.query("GRANT SELECT ON public.delphi_provider_requests TO generated_viz_reader");
      if(liveNode.status!==200||livenessFailure.nodeBody.jobs[0].workLive!==false||liveRust.status!==502)throw Error(`liveness failure must hand back to Node: Node ${liveNode.status}, Rust ${liveRust.status}`);
      handoffs.push(livenessFailure);
      await db.end();
      const health=await request("/health",null,port);
      const counters=JSON.parse(health.body);
      const failures=captures.filter(c=>!c.equal);
      fs.writeFileSync(path.join(keys,"results.json"),JSON.stringify({cases:captures.length,equal:captures.length-failures.length,failures:failures.length,counters,captures,handoffs},null,2)+"\n");
      console.log(`Rust logs and visualizations: ${captures.length} cases, ${failures.length} differences`);
      if(failures.length) throw Error(`Rust visualization byte differences: ${failures.map(c=>c.case).join(", ")}`);
    }
  };
};
