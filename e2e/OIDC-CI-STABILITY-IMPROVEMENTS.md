# OIDC Test CI Stability Improvements

## Overview

This document describes the improvements made to the OIDC authentication tests to improve stability in CI environments, particularly for the first test that runs when Cypress starts up.

## Problem

The `oidc-standard-users.cy.js` tests were failing intermittently in GitHub CI with:

- `InvalidCharacterError: Failed to execute 'atob' on 'Window'`
- This indicated the JWT token wasn't properly available when trying to decode it
- The issue was particularly common for the second test (moderator authentication)

## Root Causes

1. **Timing Issues**: CI environments are slower than local development
2. **Hard-coded Waits**: Fixed 2-second waits were insufficient for CI
3. **No Retry Logic**: Token verification didn't retry if tokens weren't ready
4. **State Pollution**: Insufficient cleanup between tests

## Improvements Made

### 1. Enhanced Token Verification with Retry Logic

**File: `cypress/support/auth-helpers.js`**

#### `verifyIDTokenClaims()`

- Added configurable timeout (default 10s)
- Uses Cypress's built-in retry mechanism with `should()`
- Properly waits for OIDC cache to be populated
- Better error messages during retries

#### `verifyCustomNamespaceClaims()`

- Added timeout parameter
- Waits for token availability before attempting decode
- Improved logging for debugging

#### `loginStandardUser()`

- Added timeout parameter for CI (default 15s)
- Waits for OIDC tokens to be stored in localStorage
- Uses proper assertions to ensure auth completion

#### `checkOidcSimulator()`

- Added retry logic for network failures
- Checks multiple endpoints (JWKS and OpenID configuration)
- Better error handling for transient failures

### 2. CI-Specific Configuration

**File: `cypress.config.js`**

Added adaptive timeouts based on CI environment:

```javascript
requestTimeout: process.env.CI ? 10000 : 5000,
defaultCommandTimeout: process.env.CI ? 10000 : 4000,
responseTimeout: process.env.CI ? 30000 : 5000,
pageLoadTimeout: process.env.CI ? 60000 : 30000,
```

Added test retry logic for CI:

```javascript
retries: process.env.CI ? { runMode: 2, openMode: 0 } : 0,
```

### 3. Custom Command for OIDC Readiness

**File: `cypress/support/commands.js`**

Added `cy.waitForOidcReady()` command:

- Progressive backoff retry strategy
- Checks multiple OIDC endpoints
- Configurable timeout and retries
- Better error messages

### 4. Improved Test Structure

**File: `cypress/e2e/auth/oidc-standard-users.cy.js`**

#### Before/After Hooks

- `before()`: One-time OIDC readiness check
- `beforeEach()`: Comprehensive state cleanup
- `afterEach()`: Clean up after each test
- CI-specific waits when detected

#### Adaptive Timeouts

- All verification functions use CI-aware timeouts
- Longer timeouts in CI (20s vs 10s)

#### Better State Isolation

- Clear all cookies, localStorage, sessionStorage
- Visit home page to reset app state
- Additional wait for JavaScript initialization in CI

## Usage in Tests

### Local Development

Tests run with standard timeouts:

```bash
npm run test -- --spec cypress/e2e/auth/oidc-standard-users.cy.js
```

### CI Environment

Tests automatically detect CI and use longer timeouts:

- GitHub Actions sets `CI=true` automatically
- Test retries enabled (2 attempts for failures)
- Progressive backoff for OIDC readiness checks

## Key Patterns for Other Tests

### 1. Always Wait for Tokens with Retry

```javascript
// Good - uses retry logic
verifyIDTokenClaims(claims, { timeout: 15000 })

// Bad - fixed wait
cy.wait(2000)
```

### 2. Use CI-Aware Timeouts

```javascript
const timeout = Cypress.env('CI') ? 15000 : 10000
loginStandardUser(email, password, { timeout })
```

### 3. Comprehensive Cleanup

```javascript
beforeEach(() => {
  cy.clearAllCookies()
  cy.clearAllLocalStorage()
  cy.clearAllSessionStorage()
  logout()
})
```

### 4. Check Service Readiness

```javascript
before(() => {
  checkOidcSimulator({ timeout: 20000 })
})
```

## Monitoring and Debugging

### Debug Output

The improved functions provide detailed logging:

- `⏳ Waiting for OIDC ID token (timeout: 10000ms)...`
- `✅ ID token found, verifying claims...`
- `🔄 OIDC readiness check attempt 1/5`

### Common Issues and Solutions

1. **Token not found in cache**
   - Increase timeout in `verifyIDTokenClaims()`
   - Check OIDC simulator is running

2. **Network timeouts**
   - `checkOidcSimulator()` now retries automatically
   - Increase timeout if needed

3. **State pollution between tests**
   - Use comprehensive cleanup in `beforeEach()`
   - Add `afterEach()` cleanup

4. **Cypress request retry conflicts**
   - Cannot use `retryOnStatusCodeFailure: true` with `failOnStatusCode: false`
   - Either let it fail on status codes (for automatic retry) or handle non-200 codes manually
   - See [Cypress request documentation](https://docs.cypress.io/api/commands/request)

## Implementation Status

### ✅ Completed

- Enhanced token verification with retry logic
- CI-specific configuration and timeouts
- Created `waitForOidcReady` command
- Fixed Cypress request option conflicts
- Created global OIDC setup module

### 🚧 Next Steps

See [OIDC-WAIT-USAGE-GUIDE.md](./OIDC-WAIT-USAGE-GUIDE.md) for:

- Where to use `waitForOidcReady` vs `checkOidcSimulator`
- How to add global OIDC setup to test files
- List of test files that would benefit from these improvements

## Future Improvements

1. **Session Caching**: Consider using `cy.session()` to cache authenticated state
2. **Parallel Test Support**: Ensure tests work when run in parallel
3. **Mock Mode**: Add option to mock OIDC for faster tests
4. **Health Checks**: Add comprehensive health check endpoint for all services

## Summary

These improvements provide:

- ✅ Automatic retry logic for token availability
- ✅ CI-aware timeouts and configuration
- ✅ Better state isolation between tests
- ✅ Comprehensive service readiness checks
- ✅ Improved debugging output
- ✅ Test retry on failure in CI

The result should be significantly more stable OIDC authentication tests in CI environments.
