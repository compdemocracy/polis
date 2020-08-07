module.exports = {
  plugins: ["mdx"],
  modify: (baseConfig, { target, dev }, webpack) => {
    const appConfig = Object.assign({}, baseConfig)

    return appConfig;
  },
};
