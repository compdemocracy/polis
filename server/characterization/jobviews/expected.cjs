const assert=require('node:assert/strict'),{isRuled}=require('./ruling.cjs');
exports.expectedViews=(golden,differences)=>{
 assert.deepEqual(Object.keys(differences),['entries']);const expected=JSON.parse(JSON.stringify(golden)),seen=new Set();
 for(const e of differences.entries){
  assert.deepEqual(Object.keys(e).sort(),['after','before','case','reason','ruling']);
  assert.ok(isRuled(e.ruling),'pending or invalid ruling: require ruled:<reference>');
  assert.ok(typeof e.reason==='string'&&e.reason.trim(),'reason required');
  const [state,view,...extra]=e.case.split('/');assert.ok(!extra.length&&Object.hasOwn(golden,state)&&Object.hasOwn(golden[state],view),'unknown case/view');
  assert.ok(!seen.has(e.case),'duplicate difference');seen.add(e.case);
  assert.deepEqual(e.before,golden[state][view],'exact before');assert.notDeepEqual(e.before,e.after,'no-op difference');expected[state][view]=e.after;
 }
 return expected;
};
