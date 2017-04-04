var path = require('path');
var webpack = require('webpack');

module.exports = {
  devtool: ['eval','sourcemap'],
  entry: [
    'webpack-hot-middleware/client',
    './vis2/vis2'
  ],
  output: {
    path: path.join(__dirname, 'develvis2'),
    filename: 'vis_bundle.js',
    publicPath: '/pub_vis2/'
  },
  plugins: [
    new webpack.HotModuleReplacementPlugin(),
    // perf test on nodes - remove this line to get warnings back.
    new webpack.DefinePlugin({
      "process.env": {
        "NODE_ENV": JSON.stringify("dev")
      }
    }),
    new webpack.NoErrorsPlugin()
  ],
  module: {
    loaders: [
      {
        test: /\.js$/,
        loaders: ['babel'],
        include: path.join(__dirname, 'vis2')
      },
      {
        test: /\.json$/, loader: "json-loader"
      }
    ]
  }
};
