const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root=process.env.CLIENT_ERROR_TEST_SOURCE || path.resolve(__dirname,'../../../..');
function modern(client, fetch) {
  const reports=[];
  let source=fs.readFileSync(path.join(root,client,'src/util/net.js'),'utf8')
    .replace(/^import .*$/gm,'').replace(/^export default PolisNet;?$/gm,'').replace(/\bexport const /g,'const ');
  source+='\nmodule.exports={PolisNet'+(client==='client-admin'?',setOidcTokenGetter':'')+'};';
  const sandbox={module:{exports:{}},URLs:{urlPrefix:'https://example.test/'},reportClientFetch:(...args)=>reports.push(args),
    fetch,URLSearchParams,Promise,setTimeout,console:{log(){},warn(){},error(){}}};
  vm.runInNewContext(source,sandbox);
  const api=sandbox.module.exports;
  if(api.setOidcTokenGetter) api.setOidcTokenGetter(async()=>null);
  return {api:api.PolisNet,reports};
}
for(const client of ['client-admin','client-report']) {
  for(const resource of ['/api/v3/math/pca2','/api/v3/comments?conversation_id=example']) {
    test(client+' preserves network rejection without duplicating global capture for '+resource,async()=>{
      const failure=new Error('HTTP 502');
      const f=modern(client,async()=>{throw failure;});
      await assert.rejects(f.api.polisGet(resource,{}),error=>error===failure);
      assert.equal(f.reports.length,0);
    });
  }
  test(client+' does not report submission failures as read failures',async()=>{
    const f=modern(client,async()=>{throw Error('HTTP 502');});
    await assert.rejects(f.api.polisPost('/api/v3/comments',{})); assert.equal(f.reports.length,0);
  });
}
test('report observes a caught JSON parse error without changing its empty-array result',async()=>{
  const f=modern('client-report',async()=>({ok:true,status:200,headers:{get:()=>null},body:{},text:async()=>'{'}));
  assert.equal((await f.api.polisGet('/api/v3/math/pca2',{})).length,0); assert.equal(f.reports.length,1);
});
test('legacy reads observe parse failures and retain the original promise',()=>{
  const reports=[], failures=[];
  const promise={then(){return this;},fail(fn){failures.push(fn);return this;}};
  const source=fs.readFileSync(path.join(root,'client-participation/js/util/net.js'),'utf8');
  const sandbox={module:{exports:{}},window:{preload:{}},require(name){return {
    './clientErrors':{reportClientFetch:(...a)=>reports.push(a)},'../eventBus':{trigger(){}},
    '../util/url':{urlPrefix:'https://example.test/'},'../util/polisStorage':{getJwtToken:()=>null},
    jquery:{ajax:()=>promise,extend:Object.assign},lodash:{isString:x=>typeof x==='string',extend:Object.assign}
  }[name];}};
  vm.runInNewContext(source,sandbox);
  for(const resource of ['api/v3/math/pca2','api/v3/comments']) {
    assert.equal(sandbox.module.exports.polisGet(resource,{}),promise);
    failures.pop()({status:200}, "parsererror");
  }
  assert.equal(reports.length,2); assert.equal(reports[0][1],'/api/v3/math/pca2'); assert.equal(reports[1][1],'/api/v3/comments');
  sandbox.module.exports.polisPost('api/v3/comments',{}); failures.pop()({status:200}, "parsererror"); assert.equal(reports.length,2);
});
