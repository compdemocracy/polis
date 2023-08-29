const fs = require('fs')
const glob = require('glob')
const path = require('path')

module.exports = function writeHeadersJson() {
  function writeHeadersJson(matchGlob, headersData = {}) {
    const files = glob.sync(path.resolve(__dirname, "dist", matchGlob))
    files.forEach((f) => {
      const headersFilePath = f + '.headersJson'
      fs.writeFileSync(headersFilePath, JSON.stringify(headersData))
    })
  }

  function writeHeadersJsonCss() {
    const headersData = {
      'x-amz-acl': 'public-read',
      'Content-Type': 'text/css',
      'Cache-Control':
        'no-transform,public,max-age=31536000,s-maxage=31536000'
    }
    writeHeadersJson('*.css', headersData)
  }

  function writeHeadersJsonHtml() {
    const headersData = {
      'x-amz-acl': 'public-read',
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache'
    }
    writeHeadersJson('*.html', headersData)
  }

  function writeHeadersJsonJs() {
    const headersData = {
      'x-amz-acl': 'public-read',
      'Content-Type': 'application/javascript',
      'Cache-Control':
        'no-transform,public,max-age=31536000,s-maxage=31536000'
    }
    writeHeadersJson('*.js', headersData)
  }

  function writeHeadersJsonMisc() {
    const headersData = {
      'Content-Type': 'image/vnd.microsoft.icon'
    }
    writeHeadersJson('favicon.ico', headersData)
  }

  writeHeadersJsonCss();
  writeHeadersJsonHtml();
  writeHeadersJsonJs();
  writeHeadersJsonMisc();
};
