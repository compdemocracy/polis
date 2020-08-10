module.exports = {
  plugins: ["mdx"],
  modify: (config, { target, dev }, webpack) => {
    const appConfig = config

    // When building SPA type app
    if (!dev && target === 'web') {
      // Rename index.html
      appConfig.plugins.forEach((plugin, i) => {
        if (plugin.constructor.name === 'HtmlWebpackPlugin') {
          appConfig.plugins[i].options.filename = 'index_admin.html'
        }
      })

      // Prefix files with `admin_` to easier to tell apart in combined file server.
      appConfig.output.filename = 'static/js/admin_bundle.[chunkhash:8].js'
      appConfig.output.chunkFilename =  'static/js/admin_[name].[chunkhash:8].chunk.js'
    }

    return appConfig
  },
};
