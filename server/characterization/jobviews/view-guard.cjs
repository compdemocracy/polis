const assert=require('node:assert/strict'),{isRuled}=require('./ruling.cjs');
const helper=p=>['client-report/src/data/provenance.js','client-participation-alpha/src/lib/provenance.ts'].includes(p);
function guard(changed,differences={entries:[]}) {
 const product=changed.some(p=>/^client-(report|participation-alpha)\/(src\/|webpack)/.test(p)&&!helper(p)&&!p.includes('/__tests__/')&&!/\.test\./.test(p));
 const rules=changed.some(p=>helper(p)||p.startsWith('server/characterization/delphi/recordings/')||p.startsWith('server/characterization/jobviews/')||/client-report\/(src\/data\/__tests__\/(jobViews\.(recordings\.test\.jsx|golden\.json)|baseline-view-source\.json)|jest\.jobviews\.config\.cjs)$/.test(p)||p==='.github/workflows/job-views.yml');
 assert.ok(!(product&&rules),'view product and baseline/comparison rules must change separately');
 for(const e of differences.entries)assert.ok(isRuled(e.ruling),'pending or invalid product ruling');
 if(changed.includes('client-report/src/data/__tests__/jobViews.golden.json'))assert.equal(differences.entries.length,0,'re-record must absorb differences');
}
module.exports={guard};
if(require.main===module){const base=process.argv[2];assert.ok(base,'base ref required');const files=require('node:child_process').execFileSync('git',['diff','--name-only',`${base}...HEAD`],{encoding:'utf8'}).trim().split('\n');const differences=require('../../../client-report/src/data/__tests__/jobViews.expected-differences.json');guard(files,differences);console.log('view golden/rules guard PASS');}
