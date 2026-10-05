const assert=require('node:assert/strict');
function guard(changed, differences) {
  const product=changed.some(p=>/^server\/(src\/|app\.ts$|index\.ts$|package(-lock)?\.json$|postgres\/)/.test(p));
  const rules=changed.some(p=>p.startsWith('server/characterization/routing/')&&!p.endsWith('/expected-differences.json')||p==='.github/workflows/routing-recordings.yml');
  assert.ok(!(product&&rules),'product and recording rules/golden may not change together');
  if(changed.includes('server/characterization/routing/golden.json')) assert.equal(differences.entries.length,0,'re-record must absorb expected differences');
  for(const e of differences.entries) {assert.equal(e.status,'ruled','pending product ruling');assert.ok(require('./ruling.cjs').isRuled(e.ruling),'ruled:<reference> required');}
}
module.exports={guard};
if(require.main===module) {
 const {execFileSync}=require('node:child_process');
 const fs=require('node:fs');
 const base=process.argv[2]; assert.ok(base,'base ref required');
 const changed=execFileSync('git',['diff','--name-only',`${base}...HEAD`],{encoding:'utf8'}).trim().split('\n');
 guard(changed,JSON.parse(fs.readFileSync(`${__dirname}/expected-differences.json`)));
 console.log('routing golden/rules guard PASS');
}
