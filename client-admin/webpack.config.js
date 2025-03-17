const path = require('path')
const HtmlWebPackPlugin = require('html-webpack-plugin')

module.exports = (env, argv) => {
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
        template: 'public/index.html',
        filename: 'index_admin.html',
        inject: 'body',
      }),
    ].filter(Boolean)
  }
}

