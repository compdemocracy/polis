const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),os=require('node:os');
const root=path.resolve(__dirname,'../../..'),c='client-report/src/components/',a='client-participation-alpha/src/components/topicAgenda/';
const mutations=[
 ['topicstats-run',c+'topicStats/TopicStats.jsx','sort().reverse()[0]','sort()[0]'],
 ['topicpage-run',c+'topicPage/TopicPage.jsx','sort().reverse()[0]','sort()[0]'],
 ['comments-run',c+'commentsReport/CommentsReport.jsx','setSelectedRunKey(runKeys[0])','setSelectedRunKey(runKeys[runKeys.length-1])'],
 ['viz-count-run',c+'topicsVizReport/TopicsVizReport.jsx','delphiTopics[runKeys[0]]','delphiTopics[runKeys[runKeys.length-1]]'],
 ['alpha-run',a+'hooks/useTopicData.ts','data.runs[runKeys[0]]','data.runs[runKeys[runKeys.length-1]]'],
 ['section-key',c+'topicPage/TopicPage.jsx','section: topic_key\n','section: topic_key.replace(/#/g, "_")\n'],
 ['paid-payload',c+'topicPage/TopicPage.jsx','topic_name: topicData?.topic_name || ""','topic_name: "changed"'],
 ['paid-auto-eligibility',c+'topicPage/TopicPage.jsx','if (!statementCheck.canGenerate) {','if (false) {'],
 ['image-job-status',c+'commentsReport/CommentsReport.jsx','job.status === "COMPLETED" && ','true && '],
 ['pending-label',c+'commentsReport/CommentsReport.jsx',' (pending narrative)"),\n',' (no narrative)"),\n'],
 ['paid-token',c+'topicPage/TopicPage.jsx','}, token);','}, undefined);'],
 ['statement-order',c+'topicPage/TopicPage.jsx','new Date(b.created_at).getTime() - new Date(a.created_at).getTime()','new Date(a.created_at).getTime() - new Date(b.created_at).getTime()'],
];
// The review's section reduce comparison is equivalent on this legacy corpus:
// run.created_at is absent. It remains documented, not counted as a killed mutant.
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'job-view-mutations-'));
try {for(const [name,file,from,to] of mutations){const full=path.join(root,file),before=fs.readFileSync(full,'utf8');assert.ok(before.includes(from),`mutation anchor missing ${name}`);const out=path.join(temp,name+'.json');try{
 fs.writeFileSync(full,before.replaceAll(from,to));
 const env={...process.env,TZ:'UTC',DELPHI_JOB_VIEWS:'false'};delete env.RECORD_JOB_VIEWS;delete env.JOB_VIEWS_OBSERVE;
 const r=spawnSync(process.execPath,['client-report/node_modules/jest/bin/jest.js','--config','client-report/jest.jobviews.config.cjs','--runInBand','--no-cache','--json','--outputFile',out],{cwd:root,encoding:'utf8',env});
 if(r.error)throw r.error;assert.ok(fs.existsSync(out),`${name}: no test result ${r.stderr}`);const result=JSON.parse(fs.readFileSync(out));
 assert.ok(r.status===1&&result.numFailedTests>0&&result.testResults.some(s=>s.assertionResults.some(t=>t.status==='failed'&&t.failureMessages.some(m=>m.includes('toEqual')))),`${name} survived or failed outside a recorded comparison: ${r.stderr}`);
 console.log(`KILLED ${name} (${result.numFailedTests} cases)`);
 } finally {fs.writeFileSync(full,before)}}console.log(`${mutations.length}/${mutations.length} non-equivalent mutations killed`)}finally{fs.rmSync(temp,{recursive:true,force:true})}
