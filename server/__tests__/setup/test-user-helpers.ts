// Utility functions for generating test users for Auth0 simulator integration tests.
// The Auth0 simulator must be running in Docker before running tests.

export function getPooledTestUser(index: number): {
  email: string;
  name: string;
  password: string;
} {
  return {
    email: `test.user.${index}@polis.test`,
    name: `Test User ${index}`,
    password: `Te$tP@ssw0rd*`,
  };
}
