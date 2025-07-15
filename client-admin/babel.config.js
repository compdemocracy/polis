module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        loose: true
      }
    ],
    ['@babel/preset-react', { runtime: 'automatic', importSource: 'theme-ui' }]
  ],
  plugins: [
    ['@babel/plugin-proposal-decorators', { legacy: true }],
    ['@babel/plugin-proposal-class-properties', { loose: true }],
    '@babel/plugin-transform-runtime'
  ]
}
