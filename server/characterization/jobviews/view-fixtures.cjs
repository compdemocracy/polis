const fs=require('node:fs'),path=require('node:path');
exports.fixture=(dir,state,file)=>{
 const source=['mixed_jobs','existing_statements'].includes(state)?'completed':state==='partial_job'?'two_models':state;
 const value=JSON.parse(JSON.parse(fs.readFileSync(path.join(dir,source,`${file}.json`))).response.body);
 if(state==='mixed_jobs'&&file==='delphi'){
  const run=Object.values(value.runs)[0];run.topics_by_layer[0][9]={topic_key:'earlier_job#0#9',topic_name:'Earlier topic in same day',created_at:'2023-11-14T18:00:00.000Z'};
 }
 if(state==='partial_job'&&file==='delphi-visualizations'){
  const old=value.jobs.find(j=>j.visualizations?.length);const first=value.jobs[0];first.status='PROCESSING';first.visualizations=old.visualizations.map(v=>({...v,url:'https://generated.invalid/partial-visualization'}));
 }
 if(state==='partial_job'&&file==='delphi'){
  const first=Object.values(value.runs)[0];first.topics_by_layer[0][8]={topic_key:'partial_job#0#8',topic_name:'Generated extra partial topic',model_name:'generated-model-beta',created_at:'2023-11-14T19:25:00.000Z'};
 }
 if(state==='existing_statements'&&file==='collectiveStatement'){
  const first=value.statements[0];value.statements.push({...first,created_at:'2023-11-14T18:00:00.000Z',statement_data:{paragraphs:[{sentences:[{clauses:[{text:'Generated older statement',citations:[]}]}]}]}});
 }
 return value;
};
