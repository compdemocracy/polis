const finalhandler = require('finalhandler');
const fs = require('fs');
const http = require('http');
const serveStatic = require('serve-static');

const port = process.env.PORT || 8080;

// Serve up public/ftp folder
const serve = serveStatic('build', {
  'index': false,
  'setHeaders': setHeaders,
});

// Set header to force download
function setHeaders (res, filePath) {
  //res.setHeader('Content-Disposition', contentDisposition(path));
  //
  try {
    const configFile = fs.readFileSync(filePath + ".headersJson");
    const headers = JSON.parse(configFile);
    const headerNames = Object.keys(headers);
    if (headerNames && headerNames.length) {
      res.setHeader('Pragma', null);
      headerNames.forEach((name) => {
        res.setHeader(name, headers[name]);
      });
    }
  } catch (e) {
    console.error(e);
  }
}

// Create server
const fileServer = http.createServer(function onRequest (req, res) {
  serve(req, res, finalhandler(req, res));
});

// Listen
fileServer.listen(port, function (err) {
  if (!err) {
    console.log('polisFileServer listening on port ' + port);
  } else {
    console.error('Error starting polisFileServer.');
    console.error(err);
  }
});
