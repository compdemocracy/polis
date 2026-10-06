const {spawnSync}=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
function run(args,env={}){const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,TZ:'UTC',...env}});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
run(['--test','server/characterization/jobviews/view-guard.test.cjs','server/characterization/jobviews/expected.test.cjs']);
run(['client-report/node_modules/jest/bin/jest.js','--config','client-report/jest.jobviews.config.cjs','--runInBand','--no-cache']);
if(!process.env.RECORD_JOB_VIEWS&&!process.env.JOB_VIEWS_OBSERVE)run(['server/characterization/jobviews/view-mutations.cjs']);
