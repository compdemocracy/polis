var path = require("path");
var express = require("express");

var app = express();
app.set('port', process.env.PORT || 8080);
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
