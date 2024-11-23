const path = require("path")
const webpack = require("webpack")
const CopyPlugin = require("copy-webpack-plugin")
const CompressionPlugin = require('compression-webpack-plugin')
const HtmlWebPackPlugin = require('html-webpack-plugin')
const EventHooksPlugin = require('event-hooks-webpack-plugin')
const LodashReplacementPlugin = require('lodash-webpack-plugin')
const lodashTemplate = require('lodash/template')
const glob = require('glob')
const fs = require('fs')
const pkg = require('./package.json')
const TerserPlugin = require("terser-webpack-plugin")

const embedServiceHostname = process.env.EMBED_SERVICE_HOSTNAME || 'pol.is';
const fbAppId = process.env.FB_APP_ID;
const gaTrackingId = process.env.GA_TRACKING_ID;
const outputDirectory = 'dist'

/**
 * Generates .headersJson files alongside files served by the file-server. Reading these files instructs file-server
 * what HTML headers should be added to each file.
 *
 * @deprecated
 */
function writeHeadersJsonForOutputFiles(isDev) {
  function writeHeadersJson(matchGlob, headersData = {}) {
    const files = glob.sync(path.resolve(__dirname, outputDirectory, matchGlob))
    files.forEach((f, i) => {
      const headersFilePath = f + '.headersJson'
      fs.writeFileSync(headersFilePath, JSON.stringify(headersData))
    })
  }

  function writeHeadersJsonHtml() {
    const headersData = {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache'
    }
    writeHeadersJson('*.html', headersData)
  }

  function writeHeadersJsonJs() {
    const headersData = {
      ...(!isDev && { 'Content-Encoding': 'gzip' }),
      'Content-Type': 'application/javascript',
      'Cache-Control':
        'no-transform,public,max-age=31536000,s-maxage=31536000'
    }
    writeHeadersJson('js/*.js', headersData)
    writeHeadersJson('*.js', headersData)
  }

  function writeHeadersJsonCss() {
    const headersData = {
      ...(!isDev && { 'Content-Encoding': 'gzip' }),
      'Content-Type': 'text/css',
      'Cache-Control':
        'no-transform,public,max-age=31536000,s-maxage=31536000'
    }
    writeHeadersJson('css/*.css', headersData)
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


module.exports = (env, options) => {
  var isDevBuild = options.mode === 'development'
  var isDevServer = process.env.WEBPACK_SERVE
  return {
    entry: [
      './js/main',
      './css/polis_main.scss'
    ],
    output: {
      publicPath: '/',
      filename: `js/participation_bundle.[chunkhash:8].js`,
      path: path.resolve(__dirname, outputDirectory),
      clean: true
    },
    resolve: {
      extensions: ['.js', '.css', '.png', '.svg'],
      alias: {
        // The following modules need deep importing of JS files
        'handlebars': path.resolve(__dirname, 'node_modules/handlebars/dist/cjs/handlebars.runtime.js'),
        'handlebones': path.resolve(__dirname, 'node_modules/handlebones/handlebones'),
        'deepcopy': path.resolve(__dirname, 'node_modules/deepcopy/deepcopy.js')
      },
      fallback: {
        util: require.resolve('util/')
      }
    },
    plugins: [
      // Define some globals
      new webpack.ProvidePlugin({
        process: 'process/browser'
      }),
      new CopyPlugin({
        patterns: [
          { from: 'public', globOptions: { ignore: ['**/index.ejs'] } },
          { from: 'api', globOptions: { ignore: ['**/embed.js'] } },
          {
            from: 'api/embed.js',
            transform(content, absoluteFrom) {
              return lodashTemplate(content.toString())({ embedServiceHostname })
            }
          },
          { from: 'node_modules/font-awesome/fonts/**/*', to: './fonts/[name][ext]' }
        ]
      }),
      new HtmlWebPackPlugin({
        template: path.resolve(__dirname, 'public/index.ejs'),
        filename: 'index.html',
        templateParameters: {
          versionString: pkg.version,
          fbAppId: fbAppId,
          gaTrackingId: gaTrackingId,
        }
      }),
      // Generate the .headersJson files ...
      new EventHooksPlugin({
        afterEmit: () => {
          console.log('Writing *.headersJson files...')
          writeHeadersJsonForOutputFiles(isDevBuild || isDevServer)
        }
      }),
      new webpack.DefinePlugin({
        'process.env.FB_APP_ID': JSON.stringify(fbAppId),
        'process.env.GA_TRACKING_ID': JSON.stringify(gaTrackingId),
      }),
      // Only compress files during production builds.
      ...((isDevBuild || isDevServer) ? [] : [
        new CompressionPlugin({
          test: /\.(js|css)$/,
          filename: '[path][base]',
          deleteOriginalAssets: true
        })
      ])
    ],
    // Only minify during production builds
    optimization: {
      minimize: !isDevBuild,
      minimizer: [new TerserPlugin()]
    },
    module: {
      rules: [
        {
          test: /\.(handlebars|hbs)$/,
          exclude: /node_modules/,
          loader: 'handlebars-loader',
          options: {
            ignorePartials: true // We load partials at runtime so ignore at compile-time
          }
        },
        {
          test: /\.m?js$/,
          exclude: [
            /node_modules/
          ],
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env', '@babel/react']
            },
          },
        },
        {
          test: /\.(png|jpg|gif|svg)$/,
          exclude: /node_modules/,
          use: ['file-loader'],
        },
        {
          test: /\.mdx?$/,
          exclude: /node_modules/,
          use: ['babel-loader', '@mdx-js/loader']
        },
        {
          test: /\.s[ac]ss$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'file-loader',
              options: { outputPath: 'css/', name: 'polis.css' }
            },
            'sass-loader'
          ]
        },
        // Shims for older modules
        {
          test: /d3-tip/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-env',
                '@babel/react'
              ],
              sourceType: 'script' // set 'this' to 'window'
            },
          },
        },
        {
          test: /deepcopy/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-env',
                '@babel/react'
              ],
              sourceType: 'script', // set 'this' to 'window'
            },
          },
        },
        {
          test: /bootstrap\/(transition|button|tooltip|affix|dropdown|collapse|popover|tab|alert)/,
          use: [
            {
              loader: 'imports-loader',
              options: {
                imports: [
                  // Expects jQuery to be present
                  'default jquery jQuery'
                ]
              }
            }
          ]
        },
        {
          test: /backbone\/backbone$/,
          use: [
            {
              loader: 'imports-loader',
              options: {
                imports: [
                  // Expects jQuery and lodash to be present
                  'default jquery $',
                  'default lodash _'
                ]
              }
            }
          ]
        },
        {
          test: /handlebones$/,
          use: [
            {
              loader: 'imports-loader',
              options: {
                imports: [
                  // Expects lodash, Backbone and handlebars to be present
                  'default handlebars Handlebars',
                  'default backbone Backbone',
                  'default lodash _'
                ]
              }
            }
          ]
        }
      ]
    }
  }
}
