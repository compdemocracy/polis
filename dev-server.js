var path = require('path');
var express = require('express');
var webpack = require('webpack');
var config = require('./webpack.config.dev');
var request = require('request');

var app = express();
var compiler = webpack(config);

app.use(require('webpack-dev-middleware')(compiler, {
  noInfo: true,
  publicPath: config.output.publicPath
}));

app.use(require('webpack-hot-middleware')(compiler));


function proxy (req, res) {
  var x = request({
    url: "http://localhost:5000" + req.path,
    qs: req.query,
    headers: req.headers,
    rejectUnauthorized:false,
  });
  req.pipe(x);
  x.pipe(res);
  x.on("error", function(err) {
    console.log("error", err);
    res.status(500).send("proxy error");
  });
}

// proxy everything else
app.get(/^\/api\//, proxy);
app.put(/^\/api\//, proxy);
app.post(/^\/api\//, proxy);

app.get(/^\/embed\/?$/, function(req, res) {
  res.sendFile(path.join(__dirname, 'embed.html'));
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(5002, '0.0.0.0', function(err) {
  if (err) {
    console.log("error", err);
    return;
  }

  console.log('Listening at http://localhost:5002');
});
