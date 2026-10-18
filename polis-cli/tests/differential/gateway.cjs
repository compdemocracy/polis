'use strict';
// The only published service: forward to the sealed proxy/control service.
// No internet destination, handler substitute, retry, or response rewrite.
// Pass the existing replay seed into the Rust fixture-only RNG seam. Node uses
// the same /begin seed before execution; no returned random value is masked.
const http = require('node:http');
let seed;
for (const [port, host, upstreamPort] of [[5000,'proxy',80],[5001,'server',5001]])
 http.createServer((req,res) => {
  if (port===5001 && req.url.startsWith('/begin?')) {
   const value=new URL(req.url,'http://localhost').searchParams.get('seed');
   if (!/^[a-f0-9]{12}$/.test(value || '')) { res.writeHead(400);res.end();return; }
   seed=value;
  }
  const headers={...req.headers};
  if (port===5000) {
   delete headers['x-polis-fixture-seed'];
   if (seed && req.url.split('?')[0]==='/api/v3/nextComment') headers['x-polis-fixture-seed']=seed;
  }
  const upstream=http.request({host,port:upstreamPort,path:req.url,method:req.method,headers,agent:false},r=>{
   res.writeHead(r.statusCode,r.headers);r.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 }).listen(port,'0.0.0.0');
