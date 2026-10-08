const test=require('node:test'),assert=require('node:assert/strict'),{expectedViews}=require('./expected.cjs');
const g={s:{v:{html:'before',calls:[]}}},entry={case:'s/v',before:g.s.v,after:{html:'after',calls:[]},reason:'generated test',ruling:'ruled:generated-test-reference'};
test('exact baseline',()=>assert.deepEqual(expectedViews(g,{entries:[]}),g));
test('named ruled difference',()=>assert.deepEqual(expectedViews(g,{entries:[entry]}).s.v,entry.after));
for(const [name,change] of [['pending',{ruling:'pending'}],['freeform',{ruling:'approved'}],['empty-reference',{ruling:'ruled:'}],['whitespace-reference',{ruling:'ruled: '}],['unknown',{case:'x/v'}],['unknown-view',{case:'s/x'}],['stale',{before:null}],['noop',{after:g.s.v}],['reason',{reason:''}],['extra',{mask:true}]])test(name,()=>assert.throws(()=>expectedViews(g,{entries:[{...entry,...change}]})));
test('duplicate',()=>assert.throws(()=>expectedViews(g,{entries:[entry,entry]})));
