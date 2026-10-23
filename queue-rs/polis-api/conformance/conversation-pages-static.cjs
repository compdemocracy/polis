"use strict";
// Fixed, generated static service for the sealed raw-response proof only.
const http=require("node:http");
let mode="normal";
const html='<!doctype html><html><head><!-- REPLACE_THIS_WITH_FB_META_TAGS --></head><body><script>window.preload="REPLACE_THIS_WITH_PRELOAD_DATA";</script>'+"a".repeat(100)+'</body></html>';
http.createServer((req,res)=>{
 if(req.url.startsWith("/control?mode=")){mode=new URL(req.url,"http://fixture").searchParams.get("mode");res.end("ok");return;}
 let body=req.url==="/index.html"?html:req.url==="/unsupportedBrowser.html"?"Unsupported generated browser":"Missing generated conversation";
 if(mode==="multiple")body=html+html.toLowerCase();
 if(mode==="large")body="a".repeat(20000);
 if(mode==="unicode")body=html+"🙂";
 if(mode==="error"){res.writeHead(404,{"Content-Length":0});res.end();return;}
 const send=()=>{res.writeHead(200,{"Content-Type":"text/html","Content-Length":Buffer.byteLength(body)});res.end(req.method==="HEAD"?undefined:body);};
 if(mode==="slow")setTimeout(send,150);else send();
}).listen(8080,"0.0.0.0");
