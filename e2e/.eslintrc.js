module.exports = {
  env: {
    'cypress/globals': true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:cypress/recommended',
    'plugin:mocha/recommended',
    'prettier',
  ],
  ignorePatterns: ['eg-cypress'],
  overrides: [],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['cypress', 'mocha'],
  rules: {},
}
