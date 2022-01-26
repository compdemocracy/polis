var path = require("path");
var webpack = require("webpack");

module.exports = {
  // devtool: "source-map",
  entry: [
    "./vis2/vis2"
  ],
  output: {
    path: path.join(__dirname, "dist"),
    filename: "vis_bundle.js",
    publicPath: "/dist/",
  },
  mode: 'production',
  optimization: {
    minimize: true,
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: "babel-loader",
        include: path.join(__dirname, "vis2"),
      }
    ]
  }
};
