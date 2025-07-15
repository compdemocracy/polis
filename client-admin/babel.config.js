module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        loose: true
      }
    ],
    ['@babel/preset-react', { runtime: 'automatic' }]
  ],
  plugins: [
    ['@babel/plugin-proposal-decorators', { legacy: true }],
    '@babel/plugin-transform-runtime'
  ]
}
