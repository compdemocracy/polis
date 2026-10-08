const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'../../..');
const recordings=process.env.DELPHI_RECORDINGS_DIR||path.join(root,'server/characterization/delphi/recordings');
function load(file){const module={exports:{}};let source=fs.readFileSync(path.join(root,file),'utf8');if(file.endsWith('.ts')&&process.env.PROVENANCE_MUTATION){const m=JSON.parse(process.env.PROVENANCE_MUTATION);assert.ok(source.includes(m.from),'mutation anchor missing');source=source.replace(m.from,m.to);}vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports});return module.exports;}
const implementations=[load('client-report/src/data/provenance.js'),load('client-participation-alpha/src/lib/provenance.ts')];
const states=['not_run','pending','running','failed','completed','two_models','rerun_after_votes','truncated_narrative','zero_vote'];
const body=(state,file)=>JSON.parse(JSON.parse(fs.readFileSync(path.join(recordings,state,`${file}.json`))).response.body);
// Expected prefixes chosen independently from the recorded job fixture inventory.
const expected={not_run:null,pending:null,running:null,failed:null,completed:'00000069-0000-4000-8000-000000000001',two_models:'0000006a-0000-4000-8000-000000000003',rerun_after_votes:'0000006b-0000-4000-8000-000000000002',truncated_narrative:'0000006c-0000-4000-8000-000000000001',zero_vote:'0000006d-0000-4000-8000-000000000001'};
for(const [i,p] of implementations.entries()) {
 for(const state of states) test(`${i}: recorded ${state}`,()=>{
  const topics=body(state,'delphi'),viz=body(state,'delphi-visualizations');const before=JSON.stringify(topics);
  const picked=p.pickTopicJob(topics.runs,viz.jobs);assert.equal(picked,expected[state]);
  for(const run of Object.values(topics.runs)) {
   const filtered=p.filterRunToJob(run,picked);
   if(filtered)assert.deepEqual(Array.from(p.jobsInRun(filtered)),[picked]);
  }
  assert.equal(JSON.stringify(topics),before);
  if(picked)assert.equal(p.vizJobFor(viz.jobs,picked)?.jobId,picked);
 });
 test(`${i}: opaque ids, malformed keys, section right suffix`,()=>{
  assert.equal(p.topicJobOf('pipeline_run_a_b#1#2'),'pipeline_run_a_b');
  for(const bad of [null,'','job','job#x#2','#0#0','job#1#2#3'])assert.equal(p.topicJobOf(bad),null);
  assert.equal(p.sectionTopicJob('pipeline_run_a_b_1_2'),'pipeline_run_a_b');assert.equal(p.sectionTopicJob('job_global_groups'),null);
 });
 test(`${i}: timestamp fallback, no input mutation, stable tie`,()=>{
  const runs={a:{topics_by_layer:{0:{0:{topic_key:'old#0#0',created_at:'2023-01-01T00:00:00'},1:{topic_key:'new#0#1',created_at:'2023-02-01T00:00:00'}}}}};
  assert.equal(p.pickTopicJob(runs,[]),'new');
  assert.equal(p.pickTopicJob(runs,[{jobId:'old',status:'COMPLETED'},{jobId:'new',status:'COMPLETED'}]),'old');
  assert.equal(p.pickTopicJob(runs,[{jobId:'report',status:'COMPLETED'}]),'new');
  assert.equal(p.filterRunToJob(runs.a,'missing'),null);assert.equal(p.vizJobFor([],'new'),null);
 });
}
for(const [i,p] of implementations.entries()) {
 const mixed={day:{topics_by_layer:{0:{0:{topic_key:'older#0#0'},1:{topic_key:'newer#0#1'}}}}};
 test(`${i}: same-day mixed prefixes choose matching newest completed job`,()=>{
  const before=JSON.stringify(mixed);
  assert.equal(p.pickTopicJob(mixed,[{jobId:'newer',status:'COMPLETED'},{jobId:'older',status:'COMPLETED'}]),'newer');
  const filtered=p.filterRunToJob(mixed.day,'newer');
  assert.deepEqual(Object.keys(filtered.topics_by_layer[0]),['1']);
  assert.equal(JSON.stringify(mixed),before);
 });
 test(`${i}: incomplete job with already-published topics does not win`,()=>{
  for(const status of ['PENDING','PROCESSING'])assert.equal(p.pickTopicJob(mixed,[{jobId:'newer',status},{jobId:'older',status:'COMPLETED'}]),'older');
 });
}
