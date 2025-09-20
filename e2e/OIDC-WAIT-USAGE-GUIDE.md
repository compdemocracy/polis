# OIDC WaitForReady Usage Guide

## Overview

The `cy.waitForOidcReady()` command provides robust OIDC system readiness checking with retry logic and progressive backoff. This is crucial for CI environments where services may take time to initialize.

## When to Use `waitForOidcReady`

### 1. **First Test in CI Pipeline** (CRITICAL)

The most important use case is in tests that are likely to run first in CI, especially `oidc-standard-users.cy.js`:

```javascript
describe('OIDC Standard User Authentication', () => {
  before(() => {
    if (Cypress.env('CI')) {
      cy.waitForOidcReady({ timeout: 30000, retries: 5 })
    }
  })
})
```

### 2. **Global Setup for Multiple Test Files** (RECOMMENDED)

For test suites with many files using OIDC authentication:

```javascript
// Option A: Use the setupOidcReadiness command (Recommended)
describe('My Test Suite', () => {
  before(() => {
    cy.setupOidcReadiness()  // Automatically handles CI vs local
  })
  
  it('should work', () => {
    // OIDC will be ready before this runs
  })
})

// Option B: Call waitForOidcReady directly for custom configuration
describe('My Test Suite', () => {
  before(() => {
    if (Cypress.env('CI')) {
      cy.waitForOidcReady({ timeout: 30000, retries: 5 })
    }
  })
})
```

### 3. **After Service Restarts** (AS NEEDED)

If your tests restart services or clear state:

```javascript
afterEach(() => {
  if (testRestartsServices) {
    cy.waitForOidcReady({ timeout: 20000, retries: 3 })
  }
})
```

## Command Options

```javascript
cy.waitForOidcReady({
  timeout: 30000,  // Total timeout in milliseconds (default: 30000)
  retries: 5       // Number of retry attempts (default: 5)
})
```

## Comparison: `waitForOidcReady` vs `checkOidcSimulator`

| Feature | `waitForOidcReady` | `checkOidcSimulator` |
|---------|-------------------|---------------------|
| **Retry Logic** | ✅ Progressive backoff | ❌ Single attempt |
| **Multiple Endpoints** | ✅ Checks JWKS + OpenID config | ✅ Same |
| **Error Recovery** | ✅ Catches and retries | ❌ Fails immediately |
| **Best For** | CI, first test, unstable networks | Local dev, quick checks |
| **Typical Time** | 1-30 seconds (depends on retries) | < 1 second |

## Implementation Strategy

### Phase 1: Critical Path (IMMEDIATE)

1. ✅ Add to `oidc-standard-users.cy.js` - Often first test in CI
2. Add to any test files that frequently fail with OIDC errors in CI

### Phase 2: Systematic Rollout (RECOMMENDED)

1. Add to test files using OIDC authentication:

   ```javascript
   describe('Your Test', () => {
     before(() => {
       cy.setupOidcReadiness()  // Add this line
     })
     // ... rest of your tests
   })
   ```

2. Target test files that use:
   - `loginStandardUser()`
   - `loginStandardUserAPI()`
   - Any OIDC-dependent functionality

### Phase 3: Optimization (FUTURE)

1. Consider using `cy.session()` to cache authenticated state
2. Move OIDC readiness to `cypress/support/e2e.js` for all tests
3. Add health check endpoints for better diagnostics

## Example: Adding to Existing Test Files

### Before (Unreliable in CI)

```javascript
describe('Admin Features', () => {
  beforeEach(() => {
    loginStandardUser('admin@polis.test', 'password')
  })
  
  it('should work', () => {
    // Test may fail if OIDC isn't ready
  })
})
```

### After (CI-Stable)

```javascript
describe('Admin Features', () => {
  before(() => {
    cy.setupOidcReadiness()  // ← Add this to ensure OIDC is ready
  })
  
  beforeEach(() => {
    loginStandardUser('admin@polis.test', 'password')
  })
  
  it('should work', () => {
    // OIDC guaranteed ready before this runs
  })
})
```

## Affected Test Files

Based on grep analysis, these files use OIDC authentication and would benefit:

### High Priority (Use OIDC heavily)

- `cypress/e2e/auth/oidc-standard-users.cy.js` ✅ (Already updated)
- `cypress/e2e/client-admin/access-control.cy.js`
- `cypress/e2e/client-admin/comment-moderation.cy.js`
- `cypress/e2e/client-admin/comment-upload.cy.js`
- `cypress/e2e/client-admin/conversation.cy.js`
- `cypress/e2e/client-admin/routes.cy.js`
- `cypress/e2e/client-admin/share.cy.js`

### Medium Priority (Some OIDC usage)

- `cypress/e2e/client-report/report-authentication.cy.js`
- `cypress/e2e/client-report/comment-report.cy.js`
- `cypress/e2e/client-report/report-functionality.cy.js`
- `cypress/e2e/client-report/reports-index.cy.js`
- `cypress/e2e/client-participation/integrated.cy.js`
- `cypress/e2e/client-participation/participant-count.cy.js`

## Monitoring Success

### Signs It's Working

- ✅ No more "atob undefined" errors in CI
- ✅ No more "OIDC simulator unreachable" in first test
- ✅ Consistent test pass rates between local and CI
- ✅ Clear log output: "✅ OIDC system confirmed ready"

### Debugging Failed Checks

If `waitForOidcReady` fails after all retries:

1. **Check service logs**: Is OIDC simulator actually running?
2. **Increase timeout**: Some CI environments are very slow
3. **Add more retries**: Network issues may need more attempts
4. **Check URLs**: Verify `AUTH_ISSUER` environment variable

```javascript
// Debug configuration
cy.waitForOidcReady({ 
  timeout: 60000,  // 1 minute for very slow CI
  retries: 10      // More retries for unstable networks
})
```

## Summary

- **Use `waitForOidcReady`** in CI environments and first-run scenarios
- **Use `checkOidcSimulator`** for quick local development checks
- **Import `oidc-setup.js`** in test files needing authentication
- **Monitor CI logs** to verify OIDC readiness before tests run

This approach ensures OIDC is ready before any authentication attempts, eliminating the most common cause of intermittent test failures in CI.
