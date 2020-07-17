// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// for some reason, this cannot be done in the dockerfile
const childProcess = require('child_process');
childProcess.execSync('cp /config/* ./config');

var config = require('./config/config.js');

var path = require("path");
var express = require("express");

var app = express();
app.set('port', config.get('static_files_report_port'));
app.use('/data', express.static('data'))
app.use('/dist', express.static('dist'))

app.get("*", function(req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Listen for requests
var server = app.listen(app.get('port'), function() {
  var port = server.address().port;
  console.log('Listening on port ' + port);
});
