'use strict';
// The only published service: forward to the sealed proxy/control service.
// No internet destination, handler substitute, retry, or response rewrite.
// Pass the existing replay seed into the Rust fixture-only RNG seam. Node uses
// the same /begin seed before execution; no returned random value is masked.
const http = require('node:http');
let seed;
// Capture only an explicitly armed route, in memory, without decoding JSON.
// The bounded copy never changes the bytes streamed to the CLI.
let numericCapture;
const numericLimit = 8 * 1024 * 1024;
for (const [port, host, upstreamPort] of [[5000,'proxy',80],[5001,'server',5001]])
 http.createServer((req,res) => {
  if (port===5001 && req.url.startsWith('/numeric-recording')) {
   const url = new URL(req.url,'http://localhost');
   if (req.method !== 'GET') { res.writeHead(405);res.end();return; }
   if (url.pathname === '/numeric-recording/reset') {
    const path = url.searchParams.get('path');
    if (!path || !path.startsWith('/api/v3/') || path.includes('?') || path.includes('#')) {
     res.writeHead(400);res.end();return;
    }
    numericCapture = {path, records:[]};
    res.setHeader('Content-Type','application/json');res.end('{}');return;
   }
   if (url.pathname === '/numeric-recording') {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({records:numericCapture?.records || []}));return;
   }
   res.writeHead(404);res.end();return;
  }
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
   if (port===5000 && numericCapture?.path===req.url.split('?')[0]) {
    const capture=numericCapture;
    // Reserve a slot at headers, so concurrent responses cannot exceed two.
    if (capture.records.length<2) {
     const record={status:r.statusCode,complete:false,overflow:false,
      encoding:r.headers['content-encoding'] || '',body:''};
     capture.records.push(record);
     const chunks=[];
     let size=0, recorded=false;
     const finish=()=>{
      if (recorded) return;
      recorded=true;
      Object.assign(record,{complete:r.complete,overflow:size>numericLimit,
       body:size<=numericLimit ? Buffer.concat(chunks).toString('base64') : ''});
     };
     r.on('data',chunk=>{size+=chunk.length;if(size<=numericLimit)chunks.push(chunk);});
     r.on('end',finish);r.on('aborted',finish);
    }
   }
   res.writeHead(r.statusCode,r.headers);r.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 }).listen(port,'0.0.0.0');
