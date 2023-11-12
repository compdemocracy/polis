const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8080;

// Function to set custom headers
function setCustomHeaders(req, res, next) {
  const filePath = __dirname + '/build' + req.path + '.headersJson';
  if (fs.existsSync(filePath)) {
    const headers = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  next();
}

// Serve static files, with headers, from build folder
app.use(setCustomHeaders);
app.use(express.static('build', { index: false }));

// Start the server
app.listen(port, () => {
  console.log(`polisFileServer listening on port ${port}`);
});
