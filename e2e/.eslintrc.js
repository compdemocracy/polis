module.exports = {
  env: {
    browser: true,
    'cypress/globals': true,
    es6: true
  },
  extends: [
    'eslint:recommended',
    'plugin:prettier/recommended',
    'prettier-standard'
  ],
  globals: {},
  parserOptions: {
    ecmaVersion: 11,
    sourceType: 'module'
  },
  plugins: ['cypress'],
  rules: {
    'cypress/assertion-before-screenshot': 'warn',
    'cypress/no-assigning-return-values': 'error',
    'cypress/no-async-tests': 'error',
    'cypress/no-force': 'warn',
    'cypress/no-unnecessary-waiting': 'error',
    'no-unused-expressions': 0
  }
}
