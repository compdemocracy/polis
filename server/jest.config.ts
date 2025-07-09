export default {
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "./tsconfig.json",
      },
    ],
    "^.+\\.(js|jsx)$": [
      "babel-jest",
      {
        presets: ["@babel/preset-env"],
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Exclude patterns for tests that shouldn't be directly run
  testPathIgnorePatterns: [
    "/__tests__/feature/",
    "/dist/",
    "/__tests__/app-loader.ts",
    "/__tests__/setup/",
  ],
  collectCoverage: true,
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "app.ts",
    "src/**/*.{js,ts}",
    "!src/**/*.test.{js,ts}",
    "!**/node_modules/**",
  ],
  coverageReporters: ["lcov", "clover", "html"],
  // detectOpenHandles: true,
  forceExit: true,
  verbose: true,
  setupFilesAfterEnv: ["./__tests__/setup/jest.setup.ts"],
  // Custom reporter provides better error reporting
  reporters: ["default", "./__tests__/setup/custom-jest-reporter.js"],
  // Add global setup and teardown files
  globalSetup: "./__tests__/setup/globalSetup.ts",
  globalTeardown: "./__tests__/setup/globalTeardown.ts",
};
