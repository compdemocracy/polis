var path = require("path");
var webpack = require("webpack");

module.exports = {
  devtool: "eval-source-map",
  entry: ["./vis2/vis2"],
  output: {
    path: path.join(__dirname, "develvis2"),
    filename: "vis_bundle.js",
    publicPath: "SET_THIS_FROM_GULP",
  },
  mode: "development",
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: "babel-loader",
        include: path.join(__dirname, "vis2"),
      },
    ],
  },
};
