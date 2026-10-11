/* Read-only browser proof: use generated local reports, never a production URL. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {assertFixtureReports,assertReportCoverage}=require('./report-quality.cjs');
const playwright=process.env.DYNAMO_PROOF_PLAYWRIGHT;
assert(playwright,'DYNAMO_PROOF_PLAYWRIGHT must point to an installed local Playwright package');
const {chromium}=require(playwright);
const base=process.env.DYNAMO_PROOF_REPORT_URL;
assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base),'local browser proof URL required');
const rid=process.env.DYNAMO_PROOF_REPORT_ID;
assert(/^rlocal[a-z0-9]+$/.test(rid),'generated local report ID required');
const output=process.env.DYNAMO_PROOF_OUTPUT;
assert(output,'DYNAMO_PROOF_OUTPUT required');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true});const receipts=[];
 try {
  for(const route of ['report','topicStats','topicReport']){
   const page=await browser.newPage({viewport:{width:1440,height:1100}});
   const errors=[];const responses=[];let narrativeEvidence;
   page.on('pageerror',error=>errors.push(error.message));
   page.on('response',async response=>{
    if(!response.url().includes('/api/'))return;
    let body;try{body=await response.text()}catch{body='unavailable'}
    responses.push({url:response.url(),status:response.status(),body});
   });
   await page.goto(`${base}/${route}/${rid}`,{waitUntil:'networkidle'});
   if(route==='report') {
    const response=await page.request.get(`${base}/api/v3/delphi/visualizations?report_id=${encodeURIComponent(rid)}`);
    assert(response.ok(),'visualization metadata endpoint succeeded');
    const metadata=await response.json();assert.equal(metadata.status,'success');
    assert(metadata.jobs?.length>0,'actual queue metadata returned with DynamoDB unavailable');
    assert(metadata.jobs.every(job=>job.workLive===false),'published completed graph has no live work');
    responses.push({url:response.url(),status:response.status(),body:JSON.stringify(metadata)});
   }
   if(route==='topicStats')await page.getByText('Group Consensus',{exact:false}).first().waitFor({timeout:30000});
   if(route==='topicReport'){
    const selector=page.locator('select');
    await selector.first().waitFor({timeout:30000});
    const options=await selector.first().locator('option').evaluateAll(options=>options.map(o=>({value:o.value,text:o.textContent})));
    const sourceResponse=await page.request.get(`${base}/api/v3/delphi/reports?report_id=${encodeURIComponent(rid)}`);
    assert(sourceResponse.ok(),'narrative source endpoint succeeded');
    const source=await sourceResponse.json();assert.equal(source.status,'success');
    const checked=assertFixtureReports(source.reports);
    const topicResponse=await page.request.get(`${base}/api/v3/delphi?report_id=${encodeURIComponent(rid)}`);
    assert(topicResponse.ok(),'topic source endpoint succeeded');
    const topics=await topicResponse.json();assert.equal(topics.status,'success');
    const checkedTopics=Object.values(topics.runs).flatMap(run=>Object.values(run.topics_by_layer).flatMap(Object.values)).length;
    assertReportCoverage(source.reports,topics.runs);
    const named=options.find(o=>o.value && source.reports?.[o.value]?.report_data);
    assert(named,'at least one available narrative section maps to the rendered selector');
    const stored=source.reports[named.value];
    const {clauses}=checked[named.value];
    await selector.first().selectOption(named.value);
    await page.waitForLoadState('networkidle');
    await page.locator('.topic-text-content .paragraph').first().waitFor({timeout:30000});
    const rendered=await page.locator('.topic-text-content').innerText();
    for(const clause of clauses)assert(rendered.includes(clause),'stored narrative clause renders exactly');
    narrativeEvidence={section:named.value,model:stored.model,job_id:stored.job_id,clauses:clauses.length,metadata:stored.metadata,checkedSections:Object.keys(checked),checkedTopics};
   }
   const body=await page.locator('body').innerText();
   await page.screenshot({path:path.join(output,route+'.png'),fullPage:true});
   await page.screenshot({path:path.join(output,route+'-viewport.png')});
   const record={route,body,errors,responses,narrativeEvidence};receipts.push(record);
   fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify(receipts,null,2));
   assert.equal(errors.length,0,route+': '+errors.join('; '));
   assert(responses.length>0,route+': API requests observed');
   assert(responses.every(r=>r.status<400),route+': '+responses.filter(r=>r.status>=400).map(r=>r.url));
   for(const response of responses){let payload;try{payload=JSON.parse(response.body)}catch{continue}assert.notEqual(payload.status,'error',response.url+': application error')}
   // Existing date-display behavior is outside this storage/queue proof.
   // Preserve it with the default-backend route and view recordings.
   if(route==='report')assert(/people voted/.test(body),route+': participant summary rendered');
   if(route==='topicReport')assert(body.length>300,route+': narrative content rendered');
   console.log('PASS',route,'API responses',responses.length);
   await page.close();
  }
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
