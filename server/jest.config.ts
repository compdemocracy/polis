import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  setupFiles: ['<rootDir>/test/settings/env-setup.ts'],
  testEnvironment: 'node',
};

export default config;
