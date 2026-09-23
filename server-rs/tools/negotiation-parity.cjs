'use strict';
// Pins `contract/negotiation.json` from the middleware `express.compress()` ACTUALLY
// resolves to, measured over real HTTP rather than read out of a library.
//
// The round-3 version of this file required the top-level `negotiator` and copied
// `compression@1.8.0`'s lists. That was the wrong package: `app.ts:310` calls
// `express.compress()`, which is `connect/lib/middleware/compress.js`, which
// `require('compression')` resolves against `connect/`, finding the NESTED
// `connect/node_modules/compression@1.5.2` — whose `accepts` in turn resolves
// `connect/node_modules/negotiator@0.5.3`. The resolution is asserted below rather
// than assumed, and the app is driven through a real socket, so reading an
// unrelated copy of the library cannot masquerade as parity again.
//
//   NODE_PATH=/Users/colinmegill/polis/server/node_modules \
//     node server-rs/tools/negotiation-parity.cjs [--write]
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const server_dir=process.env.P032_SERVER_DIR||'/Users/colinmegill/polis/server';
// Resolve exactly as the route does, from app.ts outwards.
const app_require=createRequire(path.join(server_dir,'app.ts'));
const express=app_require('express');
const express_require=createRequire(app_require.resolve('express'));
const connect_require=createRequire(express_require.resolve('connect'));
const shim=connect_require.resolve('./lib/middleware/compress');
const shim_require=createRequire(shim);
const compression=shim_require.resolve('compression');
const compression_require=createRequire(compression);
const accepts=compression_require.resolve('accepts');
const negotiator=createRequire(accepts).resolve('negotiator');
// `express.compress` must BE the resolved module, not merely resemble it.
assert.equal(express.compress,shim_require('compression'),'express.compress is not the resolved compression');
const versions={
 compression:compression_require('./package.json').version,
 accepts:createRequire(accepts)('./package.json').version,
 negotiator:createRequire(negotiator)('./package.json').version,
};
const rel=p=>path.relative(path.dirname(server_dir),p);
const HEADERS=[
 'gzip','GZIP','gzip;q=1','gzip;q=1.0','gzip;q=0','gzip;q=0.0','gzip;q=abc',
 'gzip, deflate','gzip, br','br, gzip','deflate','identity','identity;q=0',
 '*','*;q=0','*, gzip;q=0','gzip;q=0, deflate','gzip;q=0.9, br;q=0.5',
 'br;q=0.5, gzip;q=0.9','gzip ;q=0.5',' gzip , deflate ','gzip;foo=bar;q=0.4',
 'compress','compress, gzip','','   ','x-gzip','gzip;q=0.001',
 // A browser's header, and brotli alone: neither can select br from this middleware.
 'gzip, deflate, br','br','gzip, deflate, br, zstd',
 // The lazy token, and wildcards interacting with an explicit zero.
 ';q=1','gzip;q=0, *','identity;q=0, gzip','identity;q=0','*;q=0.5, gzip;q=0.5',
 // JS parseFloat and the `||` fall-through: leading whitespace, a literal tab,
 // Infinity, and a NaN quality that must fall through to header order rather
 // than disqualify the coding. Legacy inputs, but the middleware accepts them.
 'gzip;q=0.5','gzip;q=0.5junk','gzip;q= 0.5','gzip;q=\t0.5','gzip;q=abc, gzip',
 'gzip;q=Infinity','gzip;q=-Infinity','gzip;q=+0.5','gzip;q=1e-1','gzip;q=.5',
 'gzip;q=1e','gzip;q=0x10','gzip;q=abc, deflate',
];
// The route's own subset shape: JSON above the 1024-byte threshold with an ETag.
const body=JSON.stringify({tids:Array.from({length:1024},(_,i)=>i)});
const application=express();
application.set('env','production');
application.use(express.compress());
application.get('/api/v3/math/pca2',(req,res)=>{res.set('Etag','"1"');res.type('json');res.send(body);});
const listener=http.createServer(application);
const observe=port=>header=>new Promise((resolve,reject)=>{
 // An absent header is a distinct cell from an empty one; `null` requests absence.
 const headers=header===null?{}:{'Accept-Encoding':header};
 http.get({host:'127.0.0.1',port,path:'/api/v3/math/pca2?keys=tids',headers,agent:false},res=>{
  const chunks=[];res.on('data',b=>chunks.push(b));
  res.on('end',()=>{
   const raw=Buffer.concat(chunks),coding=res.headers['content-encoding']||'identity';
   const decoded=coding==='gzip'?zlib.gunzipSync(raw):coding==='deflate'?zlib.inflateSync(raw):raw;
   // The entity must survive whatever coding was negotiated.
   assert.equal(decoded.toString(),body,`decoded body differs for ${JSON.stringify(header)}`);
   assert.equal(res.statusCode,200);
   resolve(coding);
  });
 }).on('error',reject);
});
(async()=>{
 await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const send=observe(listener.address().port);
 const table=[];
 for(const header of HEADERS)table.push([header,await send(header)]);
 const absent=await send(null);
 const file=path.resolve(__dirname,'../contract/negotiation.json');
 const text=JSON.stringify({
  note:'Generated by tools/negotiation-parity.cjs from real HTTP through the resolved express.compress(); do not hand-edit.',
  resolution:{
   chain:'app.ts:310 express.compress() -> connect/lib/middleware/compress.js -> require("compression")',
   shim:rel(shim),compression:rel(compression),accepts:rel(accepts),negotiator:rel(negotiator),
   identical:'express.compress === require(compression)',
  },
  versions,
  compressionSha256:crypto.createHash('sha256').update(fs.readFileSync(compression)).digest('hex'),
  node:process.version,
  provided:['gzip','deflate','identity'],
  absentAcceptEncoding:absent,
  table,
 },null,2)+'\n';
 if(process.argv.includes('--write')){
  fs.writeFileSync(file,text);
  console.log(`negotiation parity table written from ${rel(compression)} (${versions.compression}/${versions.negotiator}): ${table.length} headers`);
 }else{
  assert.equal(fs.readFileSync(file,'utf8'),text,'contract/negotiation.json is stale; rerun with --write and review the diff');
  console.log(`negotiation parity table verified against real HTTP through ${rel(compression)} (${versions.compression}/${versions.negotiator}): ${table.length} headers`);
 }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1}).finally(()=>listener.close());
