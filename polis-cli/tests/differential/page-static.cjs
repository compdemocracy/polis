'use strict';
// Only the participation static port is present; unrelated missing static
// routes retain their existing transport-failure scenarios.
const http = require('node:http');
const body = '<!doctype html><html><head><!-- REPLACE_THIS_WITH_FB_META_TAGS --></head>' +
 '<body><script>window.preload="REPLACE_THIS_WITH_PRELOAD_DATA";</script>' +
 '<p>Generated conversation page</p></body></html>';
http.createServer((req, res) => {
 if (req.url !== '/index.html') { req.socket.destroy(); return; }
 res.writeHead(200, {'Content-Type':'text/html', 'Content-Length':Buffer.byteLength(body)});
 res.end(req.method === 'HEAD' ? undefined : body);
}).listen(8081, '0.0.0.0');
