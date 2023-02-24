const path = require('path')
const HtmlWebPackPlugin = require('html-webpack-plugin')
const HtmlWebpackTagsPlugin = require('html-webpack-tags-plugin')

module.exports = (env, argv) => {
  const enableTwitterWidget = process.env.ENABLE_TWITTER_WIDGET === 'true'
  const fbAppId = process.env.FB_APP_ID

  return {
    entry: './src/index.js',
    output: {
      path: path.join(__dirname, 'build'),
      filename: 'static/js/admin_bundle.[contenthash].js',
      clean: true
    },
    devtool: 'source-map',
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
          test: /\.md$/,
          use: ['html-loader', 'markdown-loader']
        }
      ]
    },
    plugins: [
      new HtmlWebPackPlugin({
        template: 'public/index.ejs',
        filename: 'index_admin.html',
        inject: 'body',
        templateParameters: {
          fbAppId: fbAppId
        }
      }),
      new HtmlWebpackTagsPlugin({
        tags: enableTwitterWidget ? [{
          path: 'https://platform.twitter.com/widgets.js',
          attributes: {
            async: true,
            charset: 'utf-8'
          }
        }] : [],
        append: false
      }),
    ].filter(Boolean)
  }
}

