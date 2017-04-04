var path = require("path");
var webpack = require("webpack");

module.exports = {
  // devtool: "source-map",
  entry: [
    "./vis2/vis2"
  ],
  output: {
    path: path.join(__dirname, "distvis2"),
    filename: "vis_bundle.js",
    publicPath: "/pub_vis2/"
  },
  plugins: [
    new webpack.optimize.OccurenceOrderPlugin(),
    new webpack.DefinePlugin({
      "process.env": {
        "NODE_ENV": JSON.stringify("production")
      }
    }),
    new webpack.optimize.UglifyJsPlugin({
      compressor: {
        warnings: false
      }
    })
  ],
  module: {

    preLoaders: [
      { test: /\.json$/, loader: "json"}
    ],
    loaders: [{
      test: /\.js$/,
      loaders: ["babel"],
      include: path.join(__dirname, "vis2")
    }]
  }
};
