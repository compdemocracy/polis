'use strict';
// The only published service: forward to the sealed proxy/control service.
// No internet destination, handler substitute, retry, or response rewrite.
const http = require('node:http');
for (const [port, host, upstreamPort] of [[5000,'proxy',80],[5001,'server',5001]])
 http.createServer((req,res) => {
  const upstream=http.request({host,port:upstreamPort,path:req.url,method:req.method,headers:req.headers,agent:false},r=>{
   res.writeHead(r.statusCode,r.headers);r.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 }).listen(port,'0.0.0.0');
