'use strict';
const Ajv=require('ajv'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {bytes}=require('../../server/characterization/wire.cjs');
const ajv=new Ajv({allErrors:true,strict:false});
const empty=require('../contract/empty.schema.json'),populated=require('../contract/populated.schema.json');
const validators={empty:ajv.compile(empty),populated:ajv.compile(populated),subsetEmpty:ajv.compile({...empty,required:[]}),subsetPopulated:ajv.compile({...populated,required:[]})};
const failure=ajv.compile({type:'object',required:['error','message','status'],properties:{error:{const:'Expected either math_tick param or If-Not-Match header, but not both.'},message:{const:'Expected either math_tick param or If-Not-Match header, but not both.'},status:{const:400}},additionalProperties:false});
function requestKeys(c){const q=Object.fromEntries(Array.isArray(c.request.query)?c.request.query:Object.entries(c.request.query));const p={...c.request.body,...q};const keys=p.keys;return keys===undefined||keys===null?[]:Array.isArray(keys)?keys:keys.split(',').map(s=>s.trim());}
function validate(c, fullForFixture){
 const wire=bytes(c),header=n=>c.wire.response.headers.find(h=>h.name.toLowerCase()===n)?.value;
 assert.ok(c.wire.response.completed);assert.equal(c.wire.response.termination,'end');
 assert.ok([200,304,400].includes(c.response.status));
 if(c.response.status===304){assert.equal(wire.length,0);return;}
 if(c.response.status===400){if(header('content-type').startsWith('text/html'))assert.equal(wire.toString(),'Bad Request\n');else{const b=JSON.parse(wire);assert.ok(failure(b),JSON.stringify(failure.errors));}return;}
 assert.ok(wire.length<=16*1024*1024);const raw=header('content-encoding')==='gzip'?zlib.gunzipSync(wire,{maxOutputLength:64*1024*1024}):wire;
 const b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 // A lexical round trip also rejects duplicate keys, whitespace and unapproved number spelling.
 assert.equal(JSON.stringify(b),raw.toString());
 const keys=requestKeys(c);const isEmpty=fullForFixture?fullForFixture.n===0:b.n===0;
 const v=validators[keys.length?(isEmpty?'subsetEmpty':'subsetPopulated'):(isEmpty?'empty':'populated')];
 assert.ok(v(b),JSON.stringify(v.errors));
 if(!keys.length){assert.equal(header('content-encoding'),'gzip');assert.equal(header('etag'),'"'+b.math_tick+'"');}
 else {
  assert.ok(fullForFixture,'subset requires independent full fixture');
  const expectedKeys=[...new Set(keys)].filter(k=>Object.hasOwn(fullForFixture,k));
  // Membership/correlation belongs to schema gate; order belongs ONLY to replay.
  assert.deepEqual(Object.keys(b).sort(),expectedKeys.sort());
  for(const k of Object.keys(b))assert.deepEqual(b[k],fullForFixture[k]);
  const negotiated=c.request.headers['accept-encoding']==='gzip'&&raw.length>=1024;
  assert.equal(header('content-encoding')||'identity',negotiated?'gzip':'identity');
 }
 if(b.n===0&&Object.hasOwn(b,'tids')){if(Object.hasOwn(b,'n-cmts'))assert.equal(b['n-cmts'],b.tids.length);if(b.pca)assert.equal(b.pca['comment-extremity'].length,b.tids.length);}
}
module.exports={validate,requestKeys};
