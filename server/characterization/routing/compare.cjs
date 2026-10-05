const assert = require('node:assert/strict');
exports.compare = function compare(golden, actual, differences) {
  assert.deepEqual(Object.keys(actual),Object.keys(golden),'case inventory/order changed');
  assert.deepEqual(Object.keys(differences),['entries']);
  const names=new Set();
  for(const entry of differences.entries) {
    assert.deepEqual(Object.keys(entry).sort(),['after','before','case','reason','ruling','status']);
    assert.equal(entry.status,'ruled');
    assert.ok(typeof entry.reason==='string'&&entry.reason.trim());
    assert.ok(require('./ruling.cjs').isRuled(entry.ruling));
    assert.ok(Object.hasOwn(golden,entry.case)&&!names.has(entry.case),'unknown/duplicate case');
    assert.deepEqual(entry.before,golden[entry.case],'before must match golden exactly');
    assert.notDeepEqual(entry.before,entry.after,'no-op expected difference');
    names.add(entry.case);
  }
  for(const name of Object.keys(golden)) {
    const entry=differences.entries.find(x=>x.case===name);
    assert.deepEqual(actual[name],entry?entry.after:golden[name],name);
  }
};
