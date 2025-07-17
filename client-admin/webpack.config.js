import { config } from 'dotenv'
config()
import path from 'path'
import HtmlWebPackPlugin from 'html-webpack-plugin'
import CompressionPlugin from 'compression-webpack-plugin'
import CopyPlugin from 'copy-webpack-plugin'
import TerserPlugin from 'terser-webpack-plugin'
import EventHooksPlugin from 'event-hooks-webpack-plugin'
import * as glob from 'glob'
import fs from 'fs'
import { fileURLToPath } from 'url'
import webpack from 'webpack'

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Development port
const port = process.env.PORT || 3002

export default (env, argv) => {
  const isProduction = argv.mode === 'production'
  const isDevelopment = !isProduction

  // Debug OIDC environment variables
  console.log('Building with OIDC configuration:')
  console.log('  AUTH_CLIENT_ID:', process.env.AUTH_CLIENT_ID)
  console.log('  AUTH_ISSUER:', process.env.AUTH_ISSUER)
  console.log('  AUTH_AUDIENCE:', process.env.AUTH_AUDIENCE)

  let apiUrl
  if (isDevelopment) {
    // Get API URL from CLI arg, env var, or default
    apiUrl = env?.apiUrl || process.env.API_URL || 'http://localhost:5000'
    console.log(`Using API URL: ${apiUrl}`)
  }

  return {
    mode: isProduction ? 'production' : 'development',
    entry: './src/index.js',
    output: {
      path: path.join(__dirname, 'build'),
      filename: isProduction
        ? 'static/js/admin_bundle.[contenthash].js'
        : 'static/js/admin_bundle.js',
      publicPath: '/',
      clean: true
    },
    devtool: isDevelopment ? 'eval-source-map' : 'source-map',
    devServer: isDevelopment
      ? {
          historyApiFallback: true,
          hot: true,
          port: port,
          proxy: [
            {
              context: ['/api'],
              target: apiUrl,
              changeOrigin: true,
              logLevel: 'debug',
              pathRewrite: { '^/api': '/api' },
              secure: false
            }
          ]
        }
      : {},
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: ['babel-loader']
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader']
        },
        {
          test: /\.mdx?$/,
          use: ['babel-loader', '@mdx-js/loader']
        }
      ]
    },
    optimization: {
      minimize: isProduction,
      minimizer: [new TerserPlugin()]
    },
    plugins: [
      // Common plugins for both production and development
      new HtmlWebPackPlugin({
        template: 'public/index.html',
        filename: isProduction ? 'index_admin.html' : 'index.html',
        inject: 'body'
      }),
      new webpack.DefinePlugin({
        'process.env.AUTH_CLIENT_ID': JSON.stringify(process.env.AUTH_CLIENT_ID),
        'process.env.AUTH_ISSUER': JSON.stringify(process.env.AUTH_ISSUER),
        'process.env.AUTH_AUDIENCE': JSON.stringify(process.env.AUTH_AUDIENCE)
      }),

      isProduction &&
        new CopyPlugin({
          patterns: [
            {
              from: 'public',
              to: '',
              globOptions: {
                ignore: ['**/index.html']
              }
            },
            {
              from: 'public/favicon.ico',
              to: ''
            }
          ]
        }),

      isProduction &&
        new CompressionPlugin({
          test: /\.js$/,
          exclude: /\.map$/,
          filename: '[path][base]',
          algorithm: 'gzip',
          deleteOriginalAssets: 'keep-source-map'
        }),

      isProduction &&
        new EventHooksPlugin({
          afterEmit: () => {
            console.log('Writing *.headersJson files...')

            function writeHeadersJson(matchGlob, headersData = {}) {
              const files = glob.sync(path.resolve(__dirname, 'build', matchGlob))
              files.forEach((f) => {
                const headersFilePath = f + '.headersJson'
                fs.writeFileSync(headersFilePath, JSON.stringify(headersData))
              })
            }

            // Headers for HTML files
            writeHeadersJson('*.html', {
              'Content-Type': 'text/html; charset=UTF-8',
              'Cache-Control': 'no-cache'
            })

            // Headers for JS files
            writeHeadersJson('static/js/*.js', {
              'Content-Encoding': 'gzip',
              'Content-Type': 'application/javascript',
              'Cache-Control': 'no-transform,public,max-age=31536000,s-maxage=31536000'
            })

            // Headers for other files
            writeHeadersJson('favicon.ico')
          }
        })
    ].filter(Boolean)
  }
}
