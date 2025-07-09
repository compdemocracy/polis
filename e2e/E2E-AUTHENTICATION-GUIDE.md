# E2E Authentication Guide for Polis

## Overview

This guide explains the authentication patterns used in Polis e2e tests and how to avoid breaking them during refactoring.

## Root Cause of Recent Issues

The e2e suite broke because critical helper functions were removed from `auth-helpers.js` during a "simplification" effort. These functions were still being used by various tests, causing `function is not defined` errors.

**Key Lesson: Never remove exported functions from helper files without checking ALL usages across the test suite.**

## Authentication Patterns

### 1. Standard Users (Auth0)

Standard users (`admin@polis.test`, `moderator@polis.test`) use Auth0 authentication and can access the admin interface.

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

// Verify JWT was issued
waitForJWTToken('participant_token')
verifyJWTExists('participant_token')
```

#### XID Participants

```javascript
// Visit conversation with XID
participateWithXID(conversationId, 'test-xid-123')

// Vote to trigger JWT issuance
voteOnComment('agree')

// Verify XID JWT was issued
waitForJWTToken('participant_token')
verifyJWTExists('participant_token', { xid: 'test-xid-123' })
```

## Required Helper Functions

These functions are **CRITICAL** and must not be removed:

### Auth0 Functions

- `checkAuth0Simulator()` - Verifies Auth0 simulator connectivity
- `getAuth0AccessToken()` - Gets Auth0 access token from cache
- `verifyServerJWTValidation()` - Tests server JWT validation

### JWT Verification Functions

- `verifyJWTClaims(tokenKey, expectedClaims)` - Verifies JWT payload
- `verifyCustomNamespaceClaims(tokenKey, expectedClaims)` - Verifies custom namespace claims
- `verifyIDTokenClaims(expectedClaims)` - Verifies ID token claims
- `verifyJWTExists(tokenKey, expectedClaims)` - Verifies JWT exists and is valid
- `waitForJWTToken(tokenKey, timeout)` - Waits for JWT to be stored

### Participant Functions

- `interceptParticipantPolling()` - Prevents infinite polling in participant tests
- `voteOnComment(voteType)` - Triggers JWT issuance for participants

### Conversation Helpers

- `navigateToConversationSection(conversationId, section)` - Admin UI navigation
- `verifyAdminInterfaceElements(section)` - Verifies admin UI elements

## Sticky Authentication in Cypress

### The `cy.window` Context Problem

One of the most subtle and difficult-to-debug issues in Cypress tests is "sticky authentication" where admin authentication state bleeds into participant phases of tests.

**Root Cause**: `cy.window()` blocks can hold onto authentication state and intercepts across different phases of a test.

**Symptom**: Anonymous participants are incorrectly identified as admin users (PID=0) instead of receiving new PIDs.

❌ **Problematic Pattern:**

```javascript
it('admin and participant test', () => {
  let conversationId

  // Admin phase
  loginStandardUserAPI('admin@polis.test', 'password')
  cy.window()
    .then((win) => {
      const token = win.localStorage.getItem('auth_token')
      // ... admin operations ...
      conversationId = result.conversation_id
    })
    .then(() => {
      // Participant phase - STILL IN SAME WINDOW CONTEXT!
      cy.clearLocalStorage()
      cy.visit(`/${conversationId}`)
      cy.get('#agreeButton').click() // Vote counted as admin, not new participant!
    })
})
```

✅ **Correct Pattern - Window Context Isolation:**

```javascript
it('admin and participant test', () => {
  let conversationId

  // Phase 1: Admin actions (isolated window context)
  cy.window().then((win) => {
    loginStandardUserAPI('admin@polis.test', 'password')

    cy.window().then((win) => {
      const token = win.localStorage.getItem('auth_token')
      // ... admin operations ...
      conversationId = result.conversation_id
    })
  })

  // Phase 2: Reset context completely before participant actions
  cy.then(() => {
    // Visit neutral page to establish clean context
    cy.visit('/')

    // Now participant actions work correctly
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton').click() // Creates new participant with proper PID!
  })
})
```

**Key Insight**: The critical fix is **isolating admin actions within their own `cy.window()` context** and using `cy.then()` to create a clean break before participant actions.

**What's NOT necessary** (contrary to common belief):

- Explicit state clearing (`cy.clearAllSessionStorage()`, `cy.clearLocalStorage()`)
- Resetting intercepts (`cy.intercept('**/api/**')`)
- Manual timeouts (`cy.wait(1000)`)

The `cy.window()` isolation alone solves the sticky authentication issue.

## Common Pitfalls

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

### 2. Removing Helper Functions

❌ **Wrong:**

```javascript
// Removing a function because it "looks unused"
// export function checkAuth0Simulator() { ... } // REMOVED
```

✅ **Correct:**

```javascript
// Search entire codebase before removing ANY exported function
grep -r "checkAuth0Simulator" e2e/ # Must return no results before removal
```

### 3. Not Handling Async JWT Issuance

❌ **Wrong:**

```javascript
voteOnComment('agree')
// Immediately checking for JWT - may not be issued yet
cy.window().then((win) => expect(win.localStorage.getItem('participant_token')).to.exist)
```

✅ **Correct:**

```javascript
voteOnComment('agree')
// Wait for JWT to be issued and stored
waitForJWTToken('participant_token')
verifyJWTExists('participant_token')
```

## Cypress Async/Promise Gotchas

### Critical: Commands Inside cy.should() Callbacks

One of the most frustrating Cypress errors occurs when you use Cypress commands inside a `cy.should()` callback.

❌ **Wrong - Commands inside cy.should():**

```javascript
cy.get('body').should(($body) => {
  const hasButton = $body.find('button').length > 0
  if (!hasButton) {
    cy.log('No button found') // ERROR! Command inside should()
  }
  expect(hasButton).to.be.true
})
```

**Why this fails:** `cy.should()` retries the function until assertions pass. If you have commands inside, they would be queued multiple times, causing unpredictable behavior.

✅ **Correct - Use cy.then() for debugging:**

```javascript
// First use .then() for any commands/logging
cy.get('body').then(($body) => {
  const hasButton = $body.find('button').length > 0
  if (!hasButton) {
    cy.log('No button found') // This is OK in .then()
  }
})

// Then use .should() for assertions only
cy.get('body').should(($body) => {
  const hasButton = $body.find('button').length > 0
  expect(hasButton).to.be.true // Only assertions, no commands
})
```

✅ **Alternative - Move commands outside:**

```javascript
cy.log('Checking for button...')
cy.get('body').should(($body) => {
  // Only assertions inside .should()
  expect($body.find('button').length).to.be.greaterThan(0)
})
cy.log('Button found!')
```

### Understanding .should() vs .then()

**Key Differences:**

1. **`.should()`** - Retries until timeout or pass
   - Use for assertions only
   - No commands allowed inside
   - Automatically retries the entire function

2. **`.then()`** - Runs once
   - Use for debugging, logging, or commands
   - Can contain any Cypress commands
   - Does not retry

✅ **Common Pattern - Combine both:**

```javascript
// Wait for element to appear (with retry)
cy.get('#voteButton', { timeout: 10000 }).should('exist')

// Then interact with it (no retry needed)
cy.get('#voteButton').then(($button) => {
  cy.log(`Button text: ${$button.text()}`)
  cy.wrap($button).click()
})
```

### Critical: cy.intercept() with Callbacks

One of the most common and frustrating Cypress gotchas involves using `cy.intercept()` with callback functions.

❌ **Wrong - This will NOT work:**

```javascript
cy.intercept('POST', '/api/v3/votes').as('vote')
cy.get('#agreeButton').click()
cy.wait('@vote').then((interception) => {
  // This will be undefined when using intercept with a callback!
  expect(interception.response.body.auth.token).to.exist // FAILS
})
```

❌ **Also Wrong - Modifying intercept breaks wait():**

```javascript
cy.intercept('POST', '/api/v3/votes', (req) => {
  // Any callback here changes how cy.wait() works
}).as('vote')
cy.wait('@vote').then((interception) => {
  // interception.response will be incomplete or undefined
  console.log(interception.response.body) // Might be undefined!
})
```

✅ **Correct - Use req.continue() to access response:**

```javascript
cy.intercept('POST', '/api/v3/votes', (req) => {
  req.continue((res) => {
    // Access response here
    expect(res.statusCode).to.eq(200)
    expect(res.body.auth.token).to.exist
  })
}).as('vote')
cy.get('#agreeButton').click()
cy.wait('@vote') // Just wait, don't try to access response here
```

✅ **Alternative - Use minimal intercept for simple cases:**

```javascript
// If you just need to wait for a request, don't use a callback
cy.intercept('POST', '/api/v3/votes').as('vote')
cy.get('#agreeButton').click()
cy.wait('@vote').then((interception) => {
  // Now interception.response is properly available
  expect(interception.response.body.auth.token).to.exist
})
```

### Key Rules for cy.intercept()

1. **Without callback**: `cy.wait()` returns full interception object
2. **With callback**: Must use `req.continue()` to access response
3. **With req.reply()**: Response is mocked, not from server
4. **With req.on('response')**: Use for logging without breaking wait()

### Cypress Commands Don't Return Values

❌ **Wrong:**

```javascript
const button = cy.get('button') // This is NOT a DOM element!
button.click() // This will error
```

✅ **Correct:**

```javascript
cy.get('button').then(($button) => {
  // $button is a jQuery object
  cy.wrap($button).click()
})
```

### Variables and Aliases

❌ **Wrong - Variables don't update:**

```javascript
let token
cy.window().then((win) => {
  token = win.localStorage.getItem('participant_token')
})
// token is still undefined here!
expect(token).to.exist // FAILS
```

✅ **Correct - Use .then() chains:**

```javascript
cy.window().then((win) => {
  const token = win.localStorage.getItem('participant_token')
  expect(token).to.exist // Works!
})
```

✅ **Or use aliases:**

```javascript
cy.window()
  .then((win) => {
    return win.localStorage.getItem('participant_token')
  })
  .as('token')

// Later in the test
cy.get('@token').then((token) => {
  expect(token).to.exist
})
```

### Async/Await Doesn't Work in Cypress

❌ **Wrong:**

```javascript
it('test', async () => {
  await cy.get('button').click() // This doesn't work!
})
```

✅ **Correct - Cypress handles async for you:**

```javascript
it('test', () => {
  cy.get('button').click() // Cypress queues commands automatically
})
```

## Test Debugging

### When Tests Show Login Page Instead of Admin Interface

1. Check if using `loginStandardUser()` vs `loginStandardUserAPI()`
2. Verify Auth0 simulator is running: `docker ps | grep auth0-simulator`
3. Check browser localStorage for Auth0 tokens

### When Participant Tests Fail

1. Verify conversation has comments to vote on
2. Check if `#agreeButton` element exists on page
3. Ensure polling intercepts are set up with `interceptParticipantPolling()`

### When JWT Validation Fails

1. Check if JWT token exists in localStorage
2. Verify token format (3 parts separated by dots)
3. Decode JWT payload to check claims

## Best Practices

1. **Always use search before removing functions:**

   ```bash
   grep -r "functionName" e2e/
   ```

2. **Use appropriate authentication for test type:**
   - Admin UI tests → `loginStandardUser()`
   - API-only tests → `loginStandardUserAPI()`
   - Participant tests → `participateAnonymously()` or `participateWithXID()`

3. **Isolate admin and participant phases using `cy.window()` context:**

   ```javascript
   // ✅ Correct - prevents sticky authentication
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

4. **Wait for async operations:**
   - Use `waitForJWTToken()` after voting
   - Use `cy.wait('@apiCall')` after API operations
   - Use proper timeouts for UI elements

5. **Set up intercepts for participant tests:**

   ```javascript
   beforeEach(() => {
     interceptParticipantPolling()
   })
   ```

6. **Clean up between tests:**

   ```javascript
   beforeEach(() => {
     logout() // Clear all auth state
   })
   ```

## Current Test Status

✅ **Fully Working:**

- `auth0-standard-users.cy.js` (4/4 tests)
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
