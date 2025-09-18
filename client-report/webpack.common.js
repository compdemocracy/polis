// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

require('dotenv').config();
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  entry: "./src/index.js",
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, "css-loader"],
      },
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env", "@babel/preset-react"],
          },
        },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx"],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [{ from: "public/favicon.ico", to: "favicon.ico" }],
    }),
    new HtmlWebpackPlugin({
      template: "public/index.html",
      filename: "index_report.html",
    }),
    new webpack.DefinePlugin({
      'process.env.AUTH_AUDIENCE': JSON.stringify(process.env.AUTH_AUDIENCE),
      'process.env.AUTH_NAMESPACE': JSON.stringify(process.env.AUTH_NAMESPACE),
      'process.env.AUTH_CLIENT_ID': JSON.stringify(process.env.AUTH_CLIENT_ID),
      'process.env.AUTH_ISSUER': JSON.stringify(process.env.AUTH_ISSUER),
      'process.env.DD_APPLICATION_ID': JSON.stringify(process.env.DD_APPLICATION_ID),
      'process.env.DD_CLIENT_TOKEN': JSON.stringify(process.env.DD_CLIENT_TOKEN),
      'process.env.DD_SITE': JSON.stringify(process.env.DD_SITE),
    }),
  ],
  externals: {
    d3: "d3",
  },
};
