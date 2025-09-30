const eslint = require('@eslint/js')
const globals = require('globals')
const jsxA11yPlugin = require('eslint-plugin-jsx-a11y')
const reactPlugin = require('eslint-plugin-react')
const importPlugin = require('eslint-plugin-import')
const babelParser = require('@babel/eslint-parser')

module.exports = [
  {
    // Base configuration for all files
    ignores: ['build/**', 'coverage/**']
  },
  eslint.configs.recommended,
  {
    // Import plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'import-recommended',
    rules: {
      ...importPlugin.configs.recommended.rules
    }
  },
  {
    // JSX-a11y plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'jsx-a11y-recommended',
    rules: {
      ...jsxA11yPlugin.configs.recommended.rules
    }
  },
  {
    // React plugin recommended rules
    files: ['**/*.js', '**/*.jsx'],
    name: 'react-recommended',
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules
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
        requireConfigFile: false
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        process: 'readonly'
      }
    },
    plugins: {
      'jsx-a11y': jsxA11yPlugin,
      react: reactPlugin,
      import: importPlugin
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
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['error', { args: 'none' }],
      'react/no-unknown-property': ['error', { ignore: ['sx'] }]
    }
  },
  {
    // Override for Test files
    files: ['**/*.test.js', 'jest.setup.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node // Adds 'global', 'process', etc.
      }
    },
    rules: {
      'react/prop-types': 'off'
    }
  },
  {
    // Override for Node.js files
    files: ['webpack.config.js', 'eslint.config.js', 'babel.config.js', 'jest.config.js'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-console': 'off'
    }
  }
]
