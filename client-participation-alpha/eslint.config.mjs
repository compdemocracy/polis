import js from '@eslint/js'
import pluginAstro from 'eslint-plugin-astro'
import pluginJsxA11y from 'eslint-plugin-jsx-a11y'
import pluginReact from 'eslint-plugin-react'
import pluginReactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Global ignores
  {
    ignores: ['dist/', 'node_modules/', '.astro/', '.env', '.env.*', 'coverage/']
  },

  // Base configs
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // JavaScript and TypeScript setup
  {
    files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {}
  },

  // React Configuration
  {
    files: ['**/*.{jsx,tsx}'],
    ...pluginReact.configs.flat.recommended,
    ...pluginReact.configs.flat['jsx-runtime'], // For React 17+ (and 19)
    plugins: {
      'react-hooks': pluginReactHooks,
      'jsx-a11y': pluginJsxA11y
    },
    settings: {
      react: {
        version: 'detect'
      }
    },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      ...pluginJsxA11y.configs.recommended.rules,
      'react/prop-types': 'off' // Not needed with TypeScript
    }
  },

  // Astro Configuration
  ...pluginAstro.configs.recommended,
  ...pluginAstro.configs['jsx-a11y-recommended'],
  {
    files: ['**/*.astro'],
    rules: {
      // Add any specific overrides for Astro files here
    }
  },

  // Jest/Testing Configuration
  {
    files: [
      '**/*.test.{js,ts,jsx,tsx}',
      '**/*.spec.{js,ts,jsx,tsx}',
      'jest.setup.js',
      'jest.config.mjs'
    ],
    languageOptions: {
      globals: {
        ...globals.jest,
        jest: 'readonly',
        expect: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off' // Allow require in test setup files
    }
  }
]
