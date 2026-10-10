// Database-only compatibility checks in the job-graph CI entry. These tests own
// their database/role fixtures; they do not need the full HTTP/OIDC test stack.
import base from './jest.config';
export default {
  ...base,
  testMatch: ['**/__tests__/integration/queue-substrate.test.ts'],
  setupFilesAfterEnv: [],
  globalSetup: undefined,
  globalTeardown: undefined,
  collectCoverage: false,
  reporters: ['default'],
};
