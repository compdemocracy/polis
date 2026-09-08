// Utility functions for generating test users for OIDC simulator integration tests.
// The OIDC simulator must be running in Docker before running tests.

/**
 * Pooled-user indexes reserved for the exclusive use of a single suite.
 *
 * Indexes 0-3 are the shared pool: many suites authenticate as those users, and
 * `setupAuthAndConvo()` defaults to pooled user 1. That is fine for state keyed
 * by uid or by zid, but not for state keyed by the user's `site_id`
 * (`site_domain_whitelist`), which every suite sharing a pooled user writes to
 * as one row. A suite that reads back its own site-scoped write must therefore
 * own its user outright.
 *
 * The OIDC simulator pre-registers test.user.0 through test.user.49
 * (`oidc-simulator/src/index.ts`), so indexes in the reserved block below are
 * available. Do not use these in any other suite.
 */
export const RESERVED_POOLED_USER_INDEXES = {
  /** server/__tests__/integration/domain-whitelist.test.ts */
  domainWhitelist: 40,
} as const;

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
