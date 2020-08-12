const CompressionPlugin = require('compression-webpack-plugin')
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer')
  .BundleAnalyzerPlugin
const EventHooksPlugin = require('event-hooks-webpack-plugin')
const LodashModuleReplacementPlugin = require('lodash-webpack-plugin')
const S3Plugin = require('webpack-s3-plugin')

const glob = require('glob')
const fs = require('fs')
const mri = require('mri')

// CLI commands for deploying built artefact.
// mri is also used by razzle and
const argv = process.argv.slice(2)
const cliArgs = mri(argv)

module.exports = {
  plugins: ['mdx'],
  modify: (config, { target, dev }, webpack) => {
    const appConfig = config

    // Help minimize bundle size due to lodash duplication.
    appConfig.plugins.push(
      new LodashModuleReplacementPlugin({
        currying: true,
        flattening: true,
        paths: true,
        placeholders: true,
        shorthands: true
      })
    )

    if (dev && target === 'web') {
      // appConfig.plugins = [...appConfig.plugins, new BundleAnalyzerPlugin()]
    }

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
      appConfig.output.chunkFilename =
        'static/js/admin_[name].[chunkhash:8].chunk.js'

      // Compress JS files with Gzip.
      appConfig.plugins.push(
        new CompressionPlugin({
          test: /\.js$/,
          // Leave unmodified without gz ext.
          // See: https://webpack.js.org/plugins/compression-webpack-plugin/#options
          filename: '[path][query]'
        })
      )

      appConfig.plugins.push(
        new EventHooksPlugin({
          afterEmit: () => {
            console.log('Writing *.headersJson files...')

            function writeHeadersJson(matchGlob, headersData = {}) {
              const files = glob.sync(appConfig.output.path + '/' + matchGlob)
              files.forEach((f, i) => {
                const headersFilePath = f + '.headersJson'
                fs.writeFileSync(headersFilePath, JSON.stringify(headersData))
              })
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
                'Cache-Control':
                  'no-transform,public,max-age=31536000,s-maxage=31536000'
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
        })
      )
    }

    if (cliArgs.deploy || cliArgs.deploy === 's3') {
      if (dev) {
        console.log('Deploy only possible during build. Skipped.')
      } else {
        console.log('Configuring for S3 deploy...')

        // Format: {"key": "xxx", "secret": "xxx"}
        const creds = JSON.parse(fs.readFileSync('.polis_s3_creds_client.json'))

        // See: https://github.com/MikaAK/s3-plugin-webpack
        appConfig.plugins.push(
          new S3Plugin({
            // Despite warnings in README, deploy fails without `directory` set.
            directory: 'build/public',
            // Output is broken for some reason.
            // See: https://github.com/MikaAK/s3-plugin-webpack/issues/137
            progress: false,
            s3Options: {
              accessKeyId: creds.key,
              secretAccessKey: creds.secret
            },
            s3UploadOptions: {
              // Choose bucket based on `--prod` flag when running `razzle build`.
              Bucket: cliArgs.prod
                ? process.env.S3_BUCKET_PROD
                : process.env.S3_BUCKET_PREPROD
            }
          })
        )
      }
    }

    return appConfig
  }
}
