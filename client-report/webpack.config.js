// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const common = require('./webpack.common');
const path = require('path');
const webpack = require('webpack');
const CompressionPlugin = require('compression-webpack-plugin');
const EventHooksPlugin = require('event-hooks-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const writeHeadersJsonTask = require('./writeHeadersJsonTask');

module.exports = {
  ...common,
  mode: 'production',
  output: {
    filename: 'report_bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/',
    clean: true,
  },
  plugins: [
    ...common.plugins,
    new CompressionPlugin({
      // It appears that nothing is currently using these gzipped files.
      // So we're just going to generate it with the .gz extension and not
      // delete the original.
      // TODO: Decide if we want to use these gzipped files.
      test: /\.js$/,
      // filename: '[path][base]',
      // deleteOriginalAssets: true,
    }),
    new EventHooksPlugin({
      afterEmit: () => writeHeadersJsonTask(),
    }),
    new MiniCssExtractPlugin({
      filename: 'report_style.[contenthash].css',
    }),
    new webpack.DefinePlugin({
      'process.env': {
        NODE_ENV: JSON.stringify('production'),
        SERVICE_URL: null
      }
    })
  ],
  performance: {
    // TODO: Find and remove orphan modules; Reduce bundle size.
    hints: 'warning', // 'error' for errors, 'warning' for warnings, false to disable
    maxAssetSize: 505000, // Size limit in bytes, default is 250000 (250 KB)
    maxEntrypointSize: 500000, // Size limit in bytes, default is 250000 (250 KB)
  },
};
