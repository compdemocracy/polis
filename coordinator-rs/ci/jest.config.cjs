const path = require("path");

// This is the retained three-suite Bundle witness. Full-app CI remains separate.
module.exports = {
  rootDir: path.resolve(__dirname, "../../server"),
  testEnvironment: "node",
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", {
      tsconfig: path.resolve(__dirname, "../../server/tsconfig.json"),
    }],
  },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  testMatch: ["**/__tests__/**/*.test.ts"],
  collectCoverage: false,
  forceExit: true,
  testTimeout: 60000,
};
