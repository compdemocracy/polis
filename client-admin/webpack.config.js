// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const CompressionPlugin = require('compression-webpack-plugin')
const CopyPlugin = require('copy-webpack-plugin')
const EventHooksPlugin = require('event-hooks-webpack-plugin')
const HtmlWebPackPlugin = require('html-webpack-plugin')
const path = require('path')
const webpack = require('webpack')
const writeHeadersJsonTask = require('./writeHeadersJsonTask')

const enableTwitterWidgets = process.env.ENABLE_TWITTER_WIDGETS === 'true'
const fbAppId = process.env.FB_APP_ID

module.exports = {
  entry: './src/index',
  mode: 'production',
  output: {
    filename: 'admin_bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: 'babel-loader'
      },
      {
        test: /\.md$/,
        use: 'raw-loader'
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [{ from: 'public', globOptions: { ignore: ['**/index.ejs'] } }]
    }),
    new HtmlWebPackPlugin({
      template: 'public/index.ejs',
      filename: 'index_admin.html',
      templateParameters: {
        enableTwitterWidgets,
        fbAppId
      }
    }),
    new webpack.DefinePlugin({
      'process.env.FB_APP_ID': JSON.stringify(fbAppId)
    }),
    new CompressionPlugin({
      test: /\.js$/,
      // Leave unmodified without gz ext.
      // See: https://webpack.js.org/plugins/compression-webpack-plugin/#options
      filename: '[path][base]',
      deleteOriginalAssets: true
    }),
    new EventHooksPlugin({
      afterEmit: () => writeHeadersJsonTask()
    })
  ],
  performance: {
    // default size limit is 250 KB
    hints: 'warning'
  }
}
