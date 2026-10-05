const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict'),path=require('node:path');
const mutations=[
 ['newest-completed','const complete = jobs.find','const complete = [...jobs].reverse().find'],
 ['match-prefix',' && prefixes.has(j.jobId)',''],
 ['filter-job','topicJobOf(topic.topic_key) === jobId','true'],
 ['timestamp','time > latest','time < latest'],
 ['first-prefix','if (complete) return complete.jobId','if (complete) return [...prefixes][0]'],
 ['status',"j.status === 'COMPLETED' && ",''],
 ['viz-id','jobs?.find((job) => job.jobId === jobId)','jobs?.[0]'],
];
for(const [name,from,to] of mutations){
 const r=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(__dirname,'provenance.test.cjs')],{encoding:'utf8',env:{...process.env,PROVENANCE_MUTATION:JSON.stringify({from,to})}});
 assert.ok(!r.error&&r.status===1&&/# fail [1-9]/.test(r.stdout)&&!r.stdout.includes('mutation anchor missing'),`${name} did not kill an assertion: ${r.stdout} ${r.stderr}`);
 console.log(`KILLED ${name}`);
}
console.log(`${mutations.length}/${mutations.length} mutations killed; non-greedy section regex is equivalent, excluded`);
