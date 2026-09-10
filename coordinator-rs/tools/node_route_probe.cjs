/*
 * CO08/D4 first-generation route coverage, from the second reviewer's round-2 probe
 * (cost-reduction/scripts/p2727-r2-node-review.cjs), committed unchanged in
 * substance.
 *
 * It mounts the REAL `handle_GET_math_pca2` on a real Express app over loopback
 * HTTP against the real reader, cache and PostgreSQL. Only the parameter
 * middleware is replaced by a public-fixture zid binding; the route, reader, cache,
 * database and HTTP response implementation are the shipped ones. It does not
 * cover application boot, auth, or the whole request-validation matrix.
 *
 * Its point is the caller argument: the route supplies math_tick = -1 for a
 * request without a tick, while `getPca(zid, undefined)` takes a different
 * branch. Usage: node node_route_probe.cjs <repo root>; DATABASE_URL required.
 */
'use strict';
const {createRequire} = require('module');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const req = createRequire(path.join(process.argv[2], 'server/package.json'));
req('ts-node').register({transpileOnly:true, skipProject:true, compilerOptions:{
  module:'commonjs', target:'es2020', esModuleInterop:true, allowJs:true,
  resolveJsonModule:true, skipLibCheck:true}});
const pca = req('./src/utils/pca');
const routes = req('./src/routes/math');
const pg = req('./src/db/pg-query').default;
const express = req('express');
async function main() {
  const raw = await pg.queryP_readOnly('SELECT math_tick FROM math_main WHERE zid=1 AND math_env=$1', ['rustproto']);
  const cold = await pca.getPca(1, undefined);
  const app = express();
  app.set('env', 'production');
  app.get('/api/v3/math/pca2', (r,s) => {
    // Only the parameter middleware is replaced by a public-fixture zid binding.
    r.p={zid:1, math_tick:undefined, ifNoneMatch:r.headers['if-none-match'],
      keys:r.query.keys === undefined ? undefined : r.query.keys.split(',')};
    routes.handle_GET_math_pca2(r,s);
  });
  const server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  async function get(suffix='', headers={}) {
    return new Promise((resolve,reject)=>{
      http.get({host:'127.0.0.1',port:server.address().port,path:'/api/v3/math/pca2'+suffix,headers},r=>{
        const chunks=[];
        r.on('data',b=>chunks.push(b));r.on('error',reject);
        r.on('end',()=>{
          let b=Buffer.concat(chunks);
          if(r.headers['content-encoding']==='gzip') b=zlib.gunzipSync(b);
          const body=b.length?JSON.parse(b.toString()):null;
          resolve({status:r.statusCode,etag:r.headers.etag,bodyTick:body&&body.math_tick,
            contentEncoding:r.headers['content-encoding']||'identity',n:body&&body.n});
        });
      }).on('error',reject);
    });
  }
  try {
    const whole=await get();
    const subset=await get('?keys=math_tick,n,tids');
    const conditional=await get('',{'If-None-Match':'"0"'});
    const warm=await pca.getPca(1,undefined);
    console.log(JSON.stringify({pgTickType:typeof raw[0].math_tick,coldUndefinedPresent:!!cold,
      whole,subset,conditional,warmUndefinedPresent:!!warm}));
  } finally {await new Promise(resolve=>server.close(resolve));}
}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
