module.exports = {
  // Standalone local CLI/observer modules intentionally use CommonJS, explicit
  // process configuration and aggregate stdout results; production rules remain intact.
  overrides: [
    {
      files: ["*.cjs"],
      rules: {
        "no-console": "off",
        "no-restricted-properties": "off",
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
};
