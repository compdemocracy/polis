export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/config/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/config/setup.js'],
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
}
