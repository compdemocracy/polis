var path = require("path");
var webpack = require("webpack");

module.exports = {
  devtool: "eval-source-map",
  entry: [
    // 'webpack-hot-middleware/client',
    "./vis2/vis2"
  ],
  output: {
    path: path.join(__dirname, "develvis2"),
    filename: "vis_bundle.js",
    publicPath: "SET_THIS_FROM_GULP"
  },
  plugins: [
    // new webpack.HotModuleReplacementPlugin(),
    // perf test on nodes - remove this line to get warnings back.
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("dev")
    })
    // new webpack.NoErrorsPlugin()
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        use: [
          { loader: "babel-loader" }
        ],
        include: path.join(__dirname, "vis2")
      },
    ]
  }
};
