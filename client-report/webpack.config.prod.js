// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// 1. Create version string
// 2. Clean dist folder
// 3. Bundle report

const path = require('path');
const webpack = require("webpack");
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: {
    filename: 'report_bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  module: {
    rules: [
      // {
      //   test: /\.html$/,
      //   loader: 'html-loader',
      // },
      {
        test: /\.(js)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
      templateParameters: {
        versionString: '1_2_3_4_abc',
      },
    }),
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.SERVICE_URL": JSON.stringify(process.env.SERVICE_URL),
    })
  ],
  performance: {
    // TODO: Find and remove orphan modules; Reduce bundle size.
    hints: 'warning', // 'error' for errors, 'warning' for warnings, false to disable
    maxAssetSize: 505000, // Size limit in bytes, default is 250000 (250 KB)
    maxEntrypointSize: 500000, // Size limit in bytes, default is 250000 (250 KB)
  },
};
