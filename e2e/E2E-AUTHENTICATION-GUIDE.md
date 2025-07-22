# E2E Authentication Guide for Polis

## Overview

This guide explains the authentication patterns used in Polis e2e tests and how to avoid breaking them during refactoring.

**Note**: For general Cypress patterns and gotchas, see [BEST-PRACTICES.md](./BEST-PRACTICES.md).

## Root Cause of Recent Issues

The e2e suite broke because critical helper functions were removed from `auth-helpers.js` during a "simplification" effort. These functions were still being used by various tests, causing `function is not defined` errors.

**Key Lesson: Never remove exported functions from helper files without checking ALL usages across the test suite.**

## Authentication Patterns

### 1. Standard Users (OIDC)

Standard users (`admin@polis.test`, `moderator@polis.test`) use OIDC authentication and can access the admin interface.

#### UI Authentication (for Admin Interface)

```javascript
// Use this when tests need to access admin UI pages
loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
```

#### API Authentication (for API-only operations)

```javascript
// Use this for API calls only, not UI access
loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
```

**Critical Rule: Use `loginStandardUser()` (UI auth) when tests visit admin interface pages (`/m/:id`). Use `loginStandardUserAPI()` only for pure API testing.**

### 2. Participant Authentication

#### Anonymous Participants

```javascript
// Visit conversation as anonymous user
participateAnonymously(conversationId)

// Vote to trigger JWT issuance
voteOnComment('agree')

// Verify JWT was issued (conversation-specific)
waitForJWTToken(`participant_token_${conversationId}`)
verifyJWTExists(`participant_token_${conversationId}`)
```

#### XID Participants

```javascript
// Visit conversation with XID
participateWithXID(conversationId, 'test-xid-123')

// Vote to trigger JWT issuance
voteOnComment('agree')

// Verify XID JWT was issued (conversation-specific)
waitForJWTToken(`participant_token_${conversationId}`)
verifyJWTExists(`participant_token_${conversationId}`, { xid: 'test-xid-123' })
```

## Required Helper Functions

These functions are **CRITICAL** and must not be removed:

### OIDC Functions

- `checkOidcSimulator()` - Verifies OIDC simulator connectivity
- `getOidcAccessToken()` - Gets OIDC access token from cache
- `verifyServerJWTValidation()` - Tests server JWT validation

### JWT Verification Functions

- `verifyJWTClaims(tokenKey, expectedClaims)` - Verifies JWT payload
- `verifyCustomNamespaceClaims(tokenKey, expectedClaims)` - Verifies custom namespace claims
- `verifyIDTokenClaims(expectedClaims)` - Verifies ID token claims
- `verifyJWTExists(tokenKey, expectedClaims)` - Verifies JWT exists and is valid
- `waitForJWTToken(tokenKey, timeout)` - Waits for JWT to be stored

**Note**: JWT tokens are now stored conversation-specifically as `participant_token_${conversationId}`. Helper functions should be called with the conversation-specific key.

### Participant Functions

- `interceptParticipantPolling()` - Prevents infinite polling in participant tests
- `voteOnComment(voteType)` - Triggers JWT issuance for participants

### Conversation Helpers

- `navigateToConversationSection(conversationId, section)` - Admin UI navigation
- `verifyAdminInterfaceElements(section)` - Verifies admin UI elements

## Sticky Authentication in Cypress

When tests combine admin setup with participant actions, admin authentication can "stick" and cause participants to be incorrectly identified as admin users.

**Root Cause**: `cy.window()` blocks can hold onto authentication state and intercepts across different phases of a test. See [Window Context Isolation](./BEST-PRACTICES.md#window-context-isolation) in the best practices guide for the solution pattern.

**Key Pattern for Authentication Tests:**

```javascript
it('mixed admin/participant test', () => {
  let conversationId

  // Admin phase (isolated)
  cy.window().then(() => {
    loginStandardUserAPI('admin@polis.test', 'password')
    // ... admin operations ...
  })

  // Participant phase (clean context)
  cy.then(() => {
    cy.visit(`/${conversationId}`)
    // ... participant operations ...
  })
})
```

## Common Authentication Pitfalls

### 1. Using Wrong Authentication Type

❌ **Wrong:**

```javascript
// Using API auth for admin UI access
loginStandardUserAPI('admin@polis.test', 'password')
cy.visit('/m/123') // Will show login page, not admin interface
```

✅ **Correct:**

```javascript
// Using UI auth for admin UI access
loginStandardUser('admin@polis.test', 'password')
cy.visit('/m/123') // Will show admin interface
```

### 2. Not Handling Async JWT Issuance

❌ **Wrong:**

```javascript
voteOnComment('agree')
// Immediately checking for JWT - may not be issued yet
cy.window().then((win) => expect(win.localStorage.getItem('participant_token_123')).to.exist)
```

✅ **Correct:**

```javascript
voteOnComment('agree')
// Wait for JWT to be issued and stored (conversation-specific)
waitForJWTToken(`participant_token_${conversationId}`)
verifyJWTExists(`participant_token_${conversationId}`)
```

## Test Debugging

### When Tests Show Login Page Instead of Admin Interface

1. Check if using `loginStandardUser()` vs `loginStandardUserAPI()`
2. Verify OIDC simulator is running: `docker ps | grep oidc-simulator`
3. Check browser localStorage for OIDC tokens

### When Participant Tests Fail

1. Verify conversation has comments to vote on
2. Check if `#agreeButton` element exists on page
3. Ensure polling intercepts are set up with `interceptParticipantPolling()`

### When JWT Validation Fails

1. Check if JWT token exists in localStorage with conversation-specific key (`participant_token_${conversationId}`)
2. Verify token format (3 parts separated by dots)
3. Decode JWT payload to check claims

## Best Practices for Authentication Tests

1. **Use appropriate authentication for test type:**
   - Admin UI tests → `loginStandardUser()`
   - API-only tests → `loginStandardUserAPI()`
   - Participant tests → `participateAnonymously()` or `participateWithXID()`

2. **Isolate admin and participant phases:**
   - Use window context isolation pattern (see [BEST-PRACTICES.md](./BEST-PRACTICES.md#window-context-isolation))
   - This prevents sticky authentication issues

3. **Wait for async operations:**
   - Use `waitForJWTToken()` after voting
   - Use `cy.wait('@apiCall')` after API operations
   - Use proper timeouts for UI elements

4. **Set up intercepts for participant tests:**

   ```javascript
   beforeEach(() => {
     interceptParticipantPolling()
   })
   ```

5. **Clean up between tests:**

   ```javascript
   beforeEach(() => {
     logout() // Clear all auth state
   })
   ```

## Current Test Status

✅ **Fully Working:**

- `oidc-standard-users.cy.js` (4/4 tests)
- `access-control.cy.js` (9/9 tests)

⚠️ **Minor Issues:**

- `participant-authentication.cy.js` (10/12 tests)
  - 2 tests failing due to voting interface timing issues
  - Tests pass individually but fail in sequence

## Next Steps for Remaining Issues

For the participant authentication tests with voting interface issues:

1. Add better waiting logic for conversation loading
2. Ensure test conversations have comments before voting tests
3. Consider adding retry logic for voting button detection

Remember: **The goal is reliable, maintainable tests that clearly document the authentication flows users will actually experience.**
