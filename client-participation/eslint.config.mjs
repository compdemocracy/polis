import js from "@eslint/js";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  // Global ignores (must be first)
  globalIgnores(["**/coverage/**/*", "**/dist/**/*", "**/3rdparty/**/*", "**/node_modules/**/*"]),

  // Global ESLint configuration
  {
    linterOptions: {
      reportUnusedDisableDirectives: true
    }
  },

  // JavaScript files configuration
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        gtag: true
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      "no-console": "off", // Turn off globally
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react/jsx-uses-react": "off",
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off", // Not needed in React 18

      // Additional custom rules
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^(_|React)$"
        }
      ]
    },
    settings: {
      react: {
        version: "detect"
      }
    }
  },

  // Configuration specifically for ./js folder
  {
    files: ["./js/**/*.js", "./js/**/*.jsx"],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  },

  // Configuration for webpack config files
  {
    files: ["webpack.config.js"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
]);
