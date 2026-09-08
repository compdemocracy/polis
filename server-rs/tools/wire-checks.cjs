'use strict';
// Live witnesses for the five cells the 336 recordings exclude: dynamic CORS,
// OPTIONS, HEAD, and connection reuse. Like tools/tick-zero.cjs these assert the
// candidate's own answers against the Node source, not against a recording — the
// corpus has no cell for any of them.
const cp=require('node:child_process'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),fs=require('node:fs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=path.resolve(__dirname,'../target/debug/polis-api');
async function start(env,port){
 const errors=[];let ready=false;
 const child=cp.spawn(BIN,[],{env:{...process.env,...env,LISTEN_ADDR:`127.0.0.1:${port}`,P032_FIXTURE_CLOCK:'1700000000000'},stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',b=>{for(const s of b.toString().split('\n').filter(Boolean)){if(s.startsWith('polis-api listening'))ready=true;else errors.push(s);}});
 for(let i=0;i<100&&!ready;i++)await wait(50);
 assert.ok(ready,'candidate started');
 return {child,errors};
}
const stop=async p=>{const ended=new Promise(r=>p.child.once('exit',r));p.child.kill('SIGTERM');await ended;assert.deepEqual(p.errors,[]);};
// A raw client: fetch hides the wire, and connection reuse is the wire.
function exchange(port,requests){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');let out=Buffer.alloc(0);
  socket.on('connect',()=>socket.write(requests));
  socket.on('data',d=>{out=Buffer.concat([out,d]);});
  socket.on('end',()=>resolve(out.toString('latin1')));
  socket.on('error',reject);
  socket.setTimeout(10000,()=>{socket.destroy();reject(Error('wire timeout'));});
 });
}
const headers=text=>Object.fromEntries(text.split('\r\n').slice(1).filter(Boolean).map(l=>{const i=l.indexOf(': ');return [l.slice(0,i).toLowerCase(),l.slice(i+2)];}));
async function main(){
 const checks=[];
 const fixtures=require('../../server/characterization/pca2-fixtures.json');
 const populated=fixtures.find(f=>f.shape==='populated');
 const url=`/api/v3/math/pca2?conversation_id=${populated.capability}`;
 const recorded=Number(process.env.P032_HTTP_PORT), dynamic=Number(process.env.P032_WIRE_PORT);
 assert.ok(recorded&&dynamic,'both candidate ports required');

 // 1) The recorded configuration: DOMAIN_OVERRIDE pins the origin, so every
 //    response carries the recorded https://localhost regardless of Origin.
 let p=await start({},recorded);
 try{
  const options=await exchange(recorded,`OPTIONS ${url} HTTP/1.1\r\nHost: t\r\nOrigin: https://embed.pol.is\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`);
  const oh=headers(options);
  assert.ok(options.startsWith('HTTP/1.1 204 No Content\r\n'),options.slice(0,64));
  assert.equal(options.split('\r\n\r\n')[1],'','204 carries no body');
  assert.equal(oh['content-type'],undefined,'204 strips Content-Type');
  assert.equal(oh['content-length'],undefined,'204 strips Content-Length');
  assert.equal(oh['cache-control'],'no-cache');
  assert.equal(oh.connection,'keep-alive');
  assert.equal(oh['access-control-allow-origin'],'https://localhost');
  assert.equal(oh['access-control-allow-methods'],'GET, PUT, POST, DELETE, OPTIONS');
  assert.ok(/^W\/"a-/.test(oh.etag),`weak ETag for "No Content": ${oh.etag}`);
  assert.equal(oh.vary,'Accept-Encoding');
  checks.push('OPTIONS answers 204 with Express\'s surviving headers');

  const get=await exchange(recorded,`GET ${url} HTTP/1.1\r\nHost: t\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`);
  const head=await exchange(recorded,`HEAD ${url} HTTP/1.1\r\nHost: t\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`);
  const [getHead,getBody]=[get.slice(0,get.indexOf('\r\n\r\n')),get.slice(get.indexOf('\r\n\r\n')+4)];
  const [headHead,headBody]=[head.slice(0,head.indexOf('\r\n\r\n')),head.slice(head.indexOf('\r\n\r\n')+4)];
  assert.equal(getHead,headHead,'HEAD sends the GET headers');
  assert.ok(getBody.length>0&&headBody.length===0,'HEAD sends no body');
  assert.equal(headers(get)['content-encoding'],'gzip','full mode is explicitly gzipped');
  checks.push('HEAD reproduces the GET headers with no body');

  // The compression middleware refuses to transform a HEAD, so a subset that
  // negotiates gzip on GET is identity on HEAD.
  const keys='&keys=repness,group-votes,base-clusters,votes-base,tids,pca';
  const sub=h=>`${h} ${url}${keys} HTTP/1.1\r\nHost: t\r\nAccept-Encoding: gzip\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`;
  const subsetGet=headers(await exchange(recorded,sub('GET')));
  const subsetHead=headers(await exchange(recorded,sub('HEAD')));
  assert.equal(subsetGet['content-encoding'],'gzip');
  assert.equal(subsetGet['transfer-encoding'],'chunked');
  assert.equal(subsetHead['content-encoding'],undefined,'HEAD subset is identity');
  assert.ok(Number(subsetHead['content-length'])>0);
  checks.push('negotiated subset gzip on GET, identity on HEAD');

  // Negotiation is the pinned middleware's, not a bare token match.
  const withAccept=(accept)=>`GET ${url}${keys} HTTP/1.1\r\nHost: t\r\nAccept-Encoding: ${accept}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`;
  const q1=await exchange(recorded,withAccept('gzip;q=1'));
  assert.equal(headers(q1)['content-encoding'],'gzip','gzip;q=1 is gzip, as negotiator selects');
  const q0=await exchange(recorded,withAccept('gzip;q=0'));
  assert.equal(headers(q0)['content-encoding'],undefined,'a zero quality is a refusal');
  assert.ok(Number(headers(q0)['content-length'])>0);
  // A brotli-capable Node selects br for the wildcard; this candidate has no
  // brotli, so it must refuse under its own code rather than serve gzip.
  const wildcard=await exchange(recorded,withAccept('*'));
  assert.ok(wildcard.startsWith('HTTP/1.1 502 Bad Gateway\r\n'),wildcard.slice(0,64));
  assert.ok(JSON.parse(wildcard.split('\r\n\r\n')[1]).error==='polis_err_pca2_unadmitted_encoding');
  checks.push('q-values, zero quality and the wildcard follow the pinned negotiator');

  // Two requests, one connection: the writer no longer forces close.
  const reuse=await exchange(recorded,
   `GET ${url} HTTP/1.1\r\nHost: t\r\nX-Forwarded-Proto: https\r\n\r\n`+
   `GET ${url} HTTP/1.1\r\nHost: t\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`);
  assert.equal(reuse.split('HTTP/1.1 200 OK').length-1,2,'both responses on one connection');
  assert.equal(reuse.split('Connection: keep-alive').length-1,2);
  checks.push('one connection serves successive polls');
 }finally{await stop(p);}

 // 2) Production configuration with no DOMAIN_OVERRIDE: the reflection, the
 //    absence rule and the whitelist refusal that addCorsHeader implements.
 p=await start({DOMAIN_OVERRIDE:'',DEV_MODE:'',NODE_ENV:'production',API_PROD_HOSTNAME:'pol.is'},dynamic);
 try{
  const bare=`GET ${url} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n`;
  const none=headers(await exchange(dynamic,bare+'\r\n'));
  assert.equal(none['access-control-allow-origin'],undefined,'no Origin, no CORS header');
  assert.equal(none['cache-control'],'no-cache','the other default headers still stand');

  const reflected=headers(await exchange(dynamic,bare+'Origin: https://embed.pol.is\r\n\r\n'));
  assert.equal(reflected['access-control-allow-origin'],'https://embed.pol.is');
  assert.equal(reflected['access-control-allow-credentials'],'true');

  const viaReferer=headers(await exchange(dynamic,bare+'Referer: https://embed.pol.is/x/y?q=1\r\n\r\n'));
  assert.equal(viaReferer['access-control-allow-origin'],'https://embed.pol.is','Referer is the fallback');

  const refused=await exchange(dynamic,bare+'Origin: https://evil.example\r\n\r\n');
  assert.ok(refused.startsWith('HTTP/1.1 500 Internal Server Error\r\n'),refused.slice(0,64));
  assert.equal(headers(refused)['access-control-allow-origin'],undefined,'a refused origin gets no CORS header');
  assert.equal(refused.split('\r\n\r\n')[1],'Internal Server Error\n');
  checks.push('Origin reflected, absent Origin emits nothing, non-whitelisted refused');
 }finally{await stop(p);}

 fs.writeFileSync(path.resolve(__dirname,'../evidence/wire-checks.json'),
  JSON.stringify({passed:checks.length,total:checks.length,checks},null,2)+'\n');
 console.log(`CORS/OPTIONS/HEAD/keep-alive checks ${checks.length}/${checks.length}`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
