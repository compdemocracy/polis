// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var isTrue = require('boolean');
var path = require('path');
var express = require('express');
var fs = require('fs');
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

const serviceUrl = process.env.SERVICE_URL ? process.env.SERVICE_URL : "https://pol.is";
console.log("SERVICE_URL:", serviceUrl);

function proxy (req, res) {
  const hostHeader = serviceUrl.replace(/.*\/\//,"");
  const headers =  Object.assign(req.headers, {"origin": serviceUrl, "Origin": serviceUrl, "host": hostHeader, "Host": hostHeader});

  var x = request({
    url: serviceUrl + req.path,
    qs: req.query,
    headers: headers,
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

  var html = fs.readFileSync(path.join(__dirname, 'index.html'), {encoding: "utf8"});

  html = html.replace("<%= useIntercom %>", !isTrue(process.env.DISABLE_INTERCOM));
  res.set({
    'Content-Type': 'text/html',
  });
  res.status(200).send(html);
});

app.listen(5002, '0.0.0.0', function(err) {
  if (err) {
    console.log("error", err);
    return;
  }

  console.log('Listening at http://localhost:5002');
});
