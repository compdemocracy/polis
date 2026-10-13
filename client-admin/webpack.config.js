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
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import webpack from 'webpack'

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cjsRequire = createRequire(import.meta.url)

// Development port
const port = process.env.PORT || 3002

// The theme's font (Space Mono 400, 700 and 400 italic), served from this
// build rather than a font CDN: the CSS and font files are copied unchanged
// from the pinned @fontsource/space-mono package. The directory carries the
// package version because these files are served with a one-year cache.
const spaceMonoPackage = path.dirname(cjsRequire.resolve('@fontsource/space-mono/package.json'))
const spaceMonoDir = `static/fonts/space-mono-${cjsRequire('@fontsource/space-mono/package.json').version}`
const spaceMonoStyles = ['400', '700', '400-italic']
const longCache = 'no-transform,public,max-age=31536000,s-maxage=31536000'

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
    performance: {
      hints: isProduction ? 'warning' : false,
      maxAssetSize: 2 * 1024 * 1024, // 2 MiB (accommodates bg_map.png)
      maxEntrypointSize: 512 * 1024 // 512 KiB
    },
    plugins: [
      // Common plugins for both production and development
      new HtmlWebPackPlugin({
        template: 'public/index.html',
        filename: isProduction ? 'index_admin.html' : 'index.html',
        inject: 'body',
        isProduction: isProduction, // Pass isProduction to the template
        fontStylesheets: spaceMonoStyles.map((style) => `/${spaceMonoDir}/${style}.css`)
      }),
      new CopyPlugin({
        patterns: [
          {
            context: spaceMonoPackage,
            from: `{${spaceMonoStyles.join(',')}}.css`,
            to: `${spaceMonoDir}/`,
            toType: 'dir'
          },
          {
            context: spaceMonoPackage,
            from: `files/space-mono-*-{400-normal,700-normal,400-italic}.{woff,woff2}`,
            to: `${spaceMonoDir}/`,
            toType: 'dir'
          }
        ]
      }),
      new webpack.DefinePlugin({
        'process.env.ADMIN_UIDS': JSON.stringify(process.env.ADMIN_UIDS),
        'process.env.AUTH_AUDIENCE': JSON.stringify(process.env.AUTH_AUDIENCE),
        'process.env.AUTH_CLIENT_ID': JSON.stringify(process.env.AUTH_CLIENT_ID),
        'process.env.AUTH_ISSUER': JSON.stringify(process.env.AUTH_ISSUER),
        'process.env.AUTH_NAMESPACE': JSON.stringify(process.env.AUTH_NAMESPACE)
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

            // Headers for the theme font and the emoji images (versioned paths)
            writeHeadersJson(`${spaceMonoDir}/*.css`, {
              'Content-Type': 'text/css',
              'Cache-Control': longCache
            })
            writeHeadersJson(`${spaceMonoDir}/files/*.woff2`, {
              'Content-Type': 'font/woff2',
              'Cache-Control': longCache
            })
            writeHeadersJson(`${spaceMonoDir}/files/*.woff`, {
              'Content-Type': 'font/woff',
              'Cache-Control': longCache
            })
            writeHeadersJson('twemoji/*/72x72/*.png', {
              'Content-Type': 'image/png',
              'Cache-Control': longCache
            })

            // Headers for other files
            writeHeadersJson('favicon.ico')
          }
        })
    ].filter(Boolean)
  }
}
