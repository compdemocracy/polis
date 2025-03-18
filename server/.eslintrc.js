module.exports = {
  env: {
    es2021: true,
    node: true,
    "jest/globals": true
  },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  overrides: [
    {
      files: ["bin/*.js"],
      rules: {
        "no-console": "off",
      }
    }
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "jest"],
  rules: {
    "@typescript-eslint/ban-ts-comment": 1,
    "@typescript-eslint/ban-types": 1,
    "@typescript-eslint/no-empty-function": 1,
    "@typescript-eslint/no-explicit-any": 1,
    "@typescript-eslint/no-inferrable-types": 1,
    "@typescript-eslint/no-var-requires": 1,
    "no-case-declarations": 1,
    'no-console': 2,
    "no-constant-condition": 1,
    "no-empty": 1,
    "no-extra-boolean-cast": 1,
    "no-prototype-builtins": 1,
    "no-restricted-properties": [
      2,
      {
        object: "process",
        property: "env",
        message: "Please use config.ts instead of process.env"
      }
    ],
    "no-useless-escape": 1,
    "no-var": 1,
    "prefer-const": 1,
    "prefer-rest-params": 1,
    "prefer-spread": 1
  },
  ignorePatterns: ["dist"]
};
