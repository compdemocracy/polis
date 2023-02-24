module.exports = {
  env: {
    browser: true,
    es2021: true,
    jquery: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:jsx-a11y/recommended',
    'plugin:react/recommended',
    'standard',
    'prettier',
  ],
  globals: {
    FB: 'readonly',
  },
  ignorePatterns: ['build'],
  overrides: [
    {
      files: ['.eslintrc.js', 'webpack.config.js'],
      env: { node: true },
    },
  ],
  parser: '@babel/eslint-parser',
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 2021,
    requireConfigFile: false,
    sourceType: 'module',
  },
  plugins: ['@babel', 'jsx-a11y', 'react'],
  rules: {
    camelcase: 'off',
    'jsx-a11y/no-static-element-interactions': 'warn',
    'jsx-a11y/tabindex-no-positive': 'warn',
    'object-shorthand': 'off',
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
}
