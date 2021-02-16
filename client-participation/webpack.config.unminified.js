var path = require("path");
var webpack = require("webpack");

module.exports = {
  mode: 'production',
  devtool: "source-map",
  entry: [
    "./vis2/vis2"
  ],
  output: {
    path: path.join(__dirname, "dist_foo"),
    filename: "vis_bundle.js",
    publicPath: "SET_THIS_FROM_GULP"
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: "babel-loader",
        include: path.join(__dirname, "vis2"),
      },
    ]
  }
};
