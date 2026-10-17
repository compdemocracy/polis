'use strict';
// Assert durable effects independently of response receipts; print names only.
if(process.env.P027_NETWORK_INTERNAL!=='1')throw Error('sealed fixture required');
const {Pool}=require('/app/node_modules/pg');
const {DynamoDBClient}=require('/app/node_modules/@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,ScanCommand}=require('/app/node_modules/@aws-sdk/lib-dynamodb');
const {isDeepStrictEqual}=require('node:util');
const command=process.argv[2];
(async()=>{
 const p=new Pool({connectionString:process.env.DATABASE_URL});
 const checks=[];
 async function check(name,sql,expected,params=[]){const rows=(await p.query(sql,params)).rows;if(!isDeepStrictEqual(rows,expected))throw Error(name);checks.push(name);}
 if(command==='notification subscribe'||command==='notification unsubscribe'||command==='notification set') {
  await check('subscription-state','SELECT subscribed FROM participants WHERE zid=1 AND uid=1',[{subscribed:command==='notification unsubscribe'?0:1}]);
  if(command==='notification set')await check('subscription-email','SELECT subscribe_email FROM participants_extended WHERE zid=1 AND uid=1',[{subscribe_email:'owner@example.invalid'}]);
 }
 if(command.startsWith('agenda ')) {
  const rows=(await p.query('SELECT total_selections,archetypal_selections FROM topic_agenda_selections WHERE zid=1 AND pid=(SELECT pid FROM comments WHERE txt=$1)',['Generated participant statement'])).rows;
  if(command==='agenda remove'){if(rows.length)throw Error('agenda-removal');}
  else if(rows.length!==1||rows[0].total_selections!==1||!isDeepStrictEqual(rows[0].archetypal_selections,[{topic_key:'generated-topic',selected:command==='agenda add'}]))throw Error('agenda-save');
  checks.push(command);
 }
 if(command==='delphi run'||command==='delphi batch') {
  const d=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1',endpoint:'http://dynamodb:8000',credentials:{accessKeyId:'generatedlocal',secretAccessKey:'generatedlocal'}}));
  const jobs=(await d.send(new ScanCommand({TableName:'Delphi_JobQueue'}))).Items.filter(x=>x.status==='PENDING');
  if(jobs.length!==(command==='delphi run'?1:2)||!jobs.some(j=>j.job_type==='FULL_PIPELINE')||jobs.some(j=>j.report_id!=='r2p027generated'||j.conversation_id!=='1'))throw Error('queued-jobs');
  if(command==='delphi batch'&&!jobs.some(j=>j.job_type==='CREATE_NARRATIVE_BATCH'&&JSON.parse(j.job_config).stages[0].config.model==='generated-model'))throw Error('batch-config');
  checks.push(command+'-queued-no-worker');
 }
 if(command==='final') {
  await check('domain-replaced','SELECT domain_whitelist FROM site_domain_whitelist WHERE site_id=(SELECT site_id FROM users WHERE uid=1)',[{domain_whitelist:'generated.example'}]);
  await check('allowlist-added','SELECT xid FROM xid_whitelist WHERE owner=1 ORDER BY xid',[{xid:'generated-external'}]);
  await check('verification-applied',"SELECT count(*)::int AS n FROM email_validations WHERE email='owner@example.invalid'",[{n:1}]);
  await check('account-edited','SELECT hname,tut FROM users WHERE uid=1',[{hname:'Generated edited account',tut:2}]);
  await check('no-legacy-account-enrollment','SELECT count(*)::int AS n FROM participants WHERE zid=2 AND uid=1',[{n:0}]);
  await check('conversation-upvoted-once','SELECT upvotes FROM conversations WHERE zid=1',[{upvotes:1}]);
  for(const [table,column] of [['stars','starred'],['trashes','trashed'],['crowd_mod','as_important']]) {
   await check(table+'-same-participant',`SELECT ${column} AS value FROM ${table} WHERE zid=1 AND tid=1 AND pid=(SELECT pid FROM comments WHERE txt=$1)`,[{value:table==='crowd_mod'?true:1}],['Generated participant statement']);
  }
  await check('report-selected-own-conversation','SELECT zid,tid,selection FROM report_comment_selections WHERE rid=(SELECT rid FROM reports WHERE report_id=$1)',[{zid:1,tid:0,selection:1}],['r2p027generated']);
  await check('report-renamed',"SELECT report_name FROM reports WHERE report_id='r2p027generated'",[{report_name:'Generated edited report'}]);
  await check('highlight-moderation','SELECT mod FROM participants WHERE zid=1 AND pid=0',[{mod:1}]);
  await check('math-job-enqueued',"SELECT count(*)::int AS n FROM worker_tasks WHERE task_type='update_math' AND task_data->>'math_update_type'='update'",[{n:1}]);
  await check('topic-statements-moderated','SELECT active,mod FROM comments WHERE zid=1 AND tid=1',[{active:true,mod:1}]);
  await check('mail-failure-has-no-retry',"SELECT count(*)::int AS n FROM einvites WHERE email='generated-invite@example.invalid'",[{n:1}]);
 }
 await p.end();console.log(JSON.stringify({checks,count:checks.length}));
})().catch(error=>{console.error(JSON.stringify({stage:'admin-proof',check:error.message}));process.exit(1)});
