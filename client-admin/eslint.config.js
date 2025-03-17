import eslint from '@eslint/js';
import globals from 'globals';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import reactPlugin from 'eslint-plugin-react';
import importPlugin from 'eslint-plugin-import';
import babelParser from '@babel/eslint-parser';

export default [
  {
    // Base configuration for all files
    ignores: ['build/**'],
  },
  eslint.configs.recommended,
  {
    // Import plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'import-recommended',
    rules: {
      ...importPlugin.configs.recommended.rules,
    }
  },
  {
    // JSX-a11y plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'jsx-a11y-recommended',
    rules: {
      ...jsxA11yPlugin.configs.recommended.rules,
    }
  },
  {
    // React plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'react-recommended',
    rules: {
      ...reactPlugin.configs.recommended.rules,
    }
  },
  {
    // Main configuration with your custom rules (should come AFTER the plugin configs)
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: babelParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        requireConfigFile: false,
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        FB: 'readonly',
        process: 'readonly',
        // jQuery globals
        $: 'readonly',
        jQuery: 'readonly',
      },
    },
    plugins: {
      'jsx-a11y': jsxA11yPlugin,
      'react': reactPlugin,
      'import': importPlugin,
    },
    settings: {
      react: {
        version: 'detect'
      },
      'import/resolver': {
        node: { extensions: ['.js', '.jsx'] }
      }
    },
    rules: {
      camelcase: 'off',
      'import/namespace': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',
      'object-shorthand': 'off',
      'no-unused-vars': ['error', { args: 'none' }],
      'react/no-unknown-property': ['error', { ignore: ['sx'] }]
    }
  },
  {
    // Override for Node.js files
    files: ['webpack.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  }
]; 