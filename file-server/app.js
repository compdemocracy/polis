const finalhandler = require('finalhandler');
const fs = require('fs');
const http = require('http');
const serveStatic = require('serve-static');

const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || './fs_config.json'));


// Serve up public/ftp folder
const serve = serveStatic(config.fileRoot, {
  'index': false,
  'setHeaders': setHeaders,
});

// Set header to force download
function setHeaders (res, filePath) {
  //res.setHeader('Content-Disposition', contentDisposition(path));
  //
  const configFile = fs.readFileSync(filePath + ".headersJson");
  const headers = JSON.parse(configFile);
  const headerNames = Object.keys(headers);
  if (headerNames && headerNames.length) {
    res.setHeader('Pragma', null);
    headerNames.forEach((name) => {
      res.setHeader(name, headers[name]);
    });
  }
}

// Create server
const fileServer = http.createServer(function onRequest (req, res) {
  serve(req, res, finalhandler(req, res));
});

// Listen
fileServer.listen(config.port, function (err) {
  if (!err) {
    console.log('polisFileServer listening on port ' + config.port);
  } else {
    console.error('Error starting polisFileServer.');
    console.error(err);
  }
});
