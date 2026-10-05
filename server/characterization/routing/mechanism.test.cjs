const test=require('node:test');
const assert=require('node:assert/strict');
const {compare}=require('./compare.cjs');
const {guard}=require('./guard.cjs');
const golden={a:{tid:1,cost:5},b:null};
const entry={case:'a',status:'ruled',reason:'named change',ruling:'ruled:generated-test-reference',before:golden.a,after:{tid:2,cost:5}};
test('exact matches',()=>compare(golden,structuredClone(golden),{entries:[]}));
test('named difference matches exact before/after',()=>compare(golden,{...golden,a:entry.after},{entries:[entry]}));
for(const [name,actual,diffs] of [
 ['unexpected value',{...golden,a:{tid:2,cost:5}},{entries:[]}],
 ['cost regression',{...golden,a:{tid:1,cost:6}},{entries:[]}],
 ['missing case',{a:golden.a},{entries:[]}],
 ['added case',{...golden,c:null},{entries:[]}],
 ['reordered cases',{b:null,a:golden.a},{entries:[]}],
 ['pending',golden,{entries:[{...entry,status:'pending'}]}],
 ['unknown case',golden,{entries:[{...entry,case:'c'}]}],
 ['duplicate',golden,{entries:[entry,entry]}],
 ['wrong before',golden,{entries:[{...entry,before:null}]}],
 ['stale allowance',golden,{entries:[entry]}],
 ['no-op allowance',golden,{entries:[{...entry,after:entry.before}]}],
 ['missing ruling',golden,{entries:[{...entry,ruling:''}]}],
 ['extra field',golden,{entries:[{...entry,mask:true}]}],
]) test(name,()=>assert.throws(()=>compare(golden,actual,diffs)));
test('product plus golden refused',()=>assert.throws(()=>guard(['server/src/nextComment.ts','server/characterization/routing/golden.json'],{entries:[]})));
test('product plus observer refused',()=>assert.throws(()=>guard(['server/src/comment.ts','server/characterization/routing/runtime.cjs'],{entries:[]})));
test('product plus workflow refused',()=>assert.throws(()=>guard(['server/src/comment.ts','.github/workflows/routing-recordings.yml'],{entries:[]})));
test('tests-only allowed',()=>guard(['server/characterization/routing/golden.json'],{entries:[]}));
test('product plus ruled entry allowed',()=>guard(['server/src/nextComment.ts','server/characterization/routing/expected-differences.json'],{entries:[entry]}));
test('record with outstanding entry refused',()=>assert.throws(()=>guard(['server/characterization/routing/golden.json'],{entries:[entry]})));

for(const ruling of ['anything','pending','ruled:','ruled: ']) test(`reject ruling ${JSON.stringify(ruling)}`,()=>{assert.throws(()=>compare(golden,{...golden,a:entry.after},{entries:[{...entry,ruling}]}));assert.throws(()=>guard([],{entries:[{...entry,ruling}]}));});
