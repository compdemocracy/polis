const CompressionPlugin = require('compression-webpack-plugin')
const EventHooksPlugin = require('event-hooks-webpack-plugin')
const glob = require('glob')
const fs = require('fs')

module.exports = {
  plugins: ["mdx"],
  modify: (config, { target, dev }, webpack) => {
    const appConfig = config

    // When building production SPA type app.
    if (!dev && target === 'web') {
      // Rename index.html
      appConfig.plugins.forEach((plugin, i) => {
        if (plugin.constructor.name === 'HtmlWebpackPlugin') {
          appConfig.plugins[i].options.filename = 'index_admin.html'
        }
      })

      // Prefix files with `admin_` to easier to tell apart in combined file server.
      appConfig.output.filename = 'static/js/admin_bundle.[chunkhash:8].js'
      appConfig.output.chunkFilename =  'static/js/admin_[name].[chunkhash:8].chunk.js'

      // Compress JS files with Gzip.
      appConfig.plugins.push(new CompressionPlugin({
        test: /\.js$/,
        // Leave unmodified without gz ext.
        // See: https://webpack.js.org/plugins/compression-webpack-plugin/#options
        filename: '[path][query]',
      }))

      appConfig.plugins.push(new EventHooksPlugin({
        afterEmit: () => {
          console.log('Writing *.headersJson files...')

          function writeHeadersJson(matchGlob, headersData={}) {
            const files = glob.sync(appConfig.output.path + '/' + matchGlob)
            files.forEach((f, i) => {
              const headersFilePath = f + '.headersJson'
              fs.writeFileSync(headersFilePath, JSON.stringify(headersData));
            })
          }

          function writeHeadersJsonHtml() {
            const headersData = {
              'x-amz-acl': 'public-read',
              'Content-Type': 'text/html; charset=UTF-8',
              'Cache-Control': 'no-cache',
            }
            writeHeadersJson('*.html', headersData)
          }

          function writeHeadersJsonJs() {
            const headersData = {
              'x-amz-acl': 'public-read',
              'Content-Encoding': 'gzip',
              'Content-Type': 'application/javascript',
              'Cache-Control': 'no-transform,public,max-age=31536000,s-maxage=31536000',
            }
            writeHeadersJson('static/js/*.js?(.map)', headersData)
          }

          function writeHeadersJsonMisc() {
            writeHeadersJson('favicon.ico')
          }

          writeHeadersJsonHtml()
          writeHeadersJsonJs()
          writeHeadersJsonMisc()
        }
      }))
    }

    return appConfig
  },
};
