import eslint from '@eslint/js';
import cypressPlugin from 'eslint-plugin-cypress';
import mochaPlugin from 'eslint-plugin-mocha';
import prettierConfig from 'eslint-config-prettier';

export default [
  eslint.configs.recommended,
  {
    ignores: ['eg-cypress/**/*']
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...cypressPlugin.environments.globals.globals,
        // ES2021 globals
        globalThis: 'readonly',
        // Node.js globals
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    plugins: {
      cypress: cypressPlugin,
      mocha: mochaPlugin,
    },
    rules: {
      ...cypressPlugin.configs.recommended.rules,
      ...mochaPlugin.configs.recommended.rules,
    },
  },
  prettierConfig,
]; 