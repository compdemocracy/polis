import js from '@eslint/js'
import cypressPlugin from 'eslint-plugin-cypress'
import mochaPlugin from 'eslint-plugin-mocha'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    // This configuration object applies to all JS/MJS files.
    files: ['**/*.js', '**/*.mjs'],
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // This configuration is specific to Cypress files.
    files: ['cypress/**/*.js', 'cypress/**/*.mjs'],
    ...cypressPlugin.configs.recommended,
    plugins: {
      ...cypressPlugin.configs.recommended.plugins,
      mocha: mochaPlugin,
    },
    rules: {
      ...cypressPlugin.configs.recommended.rules,
      ...mochaPlugin.configs.recommended.rules,
      'mocha/no-mocha-arrows': 'off',
      'cypress/no-unnecessary-waiting': 'off',
    },
  },
  prettierConfig,
]
