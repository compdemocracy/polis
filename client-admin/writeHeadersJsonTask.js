// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// TODO: Share this between client apps.

const fs = require('fs')
const glob = require('glob')
const path = require('path')

module.exports = function writeHeadersJson() {
  function writeHeadersJson(matchGlob, headersData = {}) {
    const files = glob.sync(path.resolve(__dirname, 'dist', matchGlob))
    files.forEach((f) => {
      const headersFilePath = f + '.headersJson'
      fs.writeFileSync(headersFilePath, JSON.stringify(headersData))
    })
  }

  function writeHeadersJsonCss() {
    const headersData = {
      'x-amz-acl': 'public-read',
      'Content-Type': 'text/css',
      'Cache-Control': 'no-transform,public,max-age=31536000,s-maxage=31536000'
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
      'Content-Encoding': 'gzip',
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-transform,public,max-age=31536000,s-maxage=31536000'
    }
    writeHeadersJson('*.js', headersData)
  }

  function writeHeadersJsonMisc() {
    const headersData = {
      'Content-Type': 'image/vnd.microsoft.icon'
    }
    writeHeadersJson('favicon.ico', headersData)
  }

  writeHeadersJsonCss()
  writeHeadersJsonHtml()
  writeHeadersJsonJs()
  writeHeadersJsonMisc()
}
