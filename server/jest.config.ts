import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  setupFiles: ["<rootDir>/test/settings/env-setup.ts"],
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};

export default config;
