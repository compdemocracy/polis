// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const common = require('./webpack.common');
const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const serviceUrl = process.env.SERVICE_URL || 'http://localhost:5000';

module.exports = {
  ...common,
  mode: 'development',
  devtool: 'inline-cheap-module-source-map',
  output: {
    filename: 'report_bundle.js',
    path: path.resolve(__dirname, 'devel'),
    publicPath: '/',
  },
  plugins: [
    ...common.plugins,
    new MiniCssExtractPlugin({
      filename: 'report_style.css',
    }),
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('development'),
      'process.env.SERVICE_URL': JSON.stringify(process.env.SERVICE_URL),
    }),
    new webpack.HotModuleReplacementPlugin(),
  ],
  devServer: {
    compress: true,
    hot: true,
    port: 5010,
    proxy: {
      '/api': {
        target: serviceUrl,
        secure: false
      }
    },
    static: {
      directory: path.join(__dirname, 'public'),
    },
    historyApiFallback: {
      index: '/index_report.html',
      rewrites: [
        { from: /^\/report\/.*$/, to: '/index_report.html' },
        { from: /^\/commentsReport\/.*$/, to: '/index_report.html' },
        { from: /^\/topicReport\/.*$/, to: '/index_report.html' },
        { from: /^\/narrativeReport\/.*$/, to: '/index_report.html' },
        { from: /^\/topicsVizReport\/.*$/, to: '/index_report.html' },
        { from: /^\/exportReport\/.*$/, to: '/index_report.html' },
        { from: /^\/topicPrioritize\/.*$/, to: '/index_report.html' },
        { from: /^\/topicPrioritizeSimple\/.*$/, to: '/index_report.html' },
        { from: /^\/topicAgenda\/.*$/, to: '/index_report.html' },
        { from: /^\/topicHierarchy\/.*$/, to: '/index_report.html' }
      ]
    }
  },
  performance: {
    // TODO: Find and remove orphan modules; Reduce bundle size.
    hints: false, // 'error' for errors, 'warning' for warnings, false to disable
    maxAssetSize: 7100000, // Size limit in bytes, default is 250000 (250 KB)
    maxEntrypointSize: 7100000, // Size limit in bytes, default is 250000 (250 KB)
  },
};
