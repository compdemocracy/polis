# Cypress E2E Best Practices

This document contains general Cypress patterns, gotchas, and best practices that apply across all test types.

## Table of Contents

1. [Core Cypress Concepts](#core-cypress-concepts)
2. [Async/Promise Patterns](#asyncpromise-patterns)
3. [Window Context Isolation](#window-context-isolation)
4. [Command Best Practices](#command-best-practices)
5. [Debugging Tips](#debugging-tips)
6. [Code Maintenance](#code-maintenance)

## Core Cypress Concepts

### Commands Don't Return Values

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

### Async/Await Doesn't Work in Cypress

❌ **Wrong:**

```javascript
it('test', async () => {
  await cy.get('button').click() // This doesn't work!
})
```

✅ **Correct:**

```javascript
it('test', () => {
  cy.get('button').click() // Cypress queues commands automatically
})
```

## Async/Promise Patterns

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

### cy.intercept() with Callbacks

One of the most common Cypress gotchas involves using `cy.intercept()` with callback functions.

❌ **Wrong - This will NOT work:**

```javascript
cy.intercept('POST', '/api/v3/votes').as('vote')
cy.get('#agreeButton').click()
cy.wait('@vote').then((interception) => {
  // This will be undefined when using intercept with a callback!
  expect(interception.response.body.auth.token).to.exist // FAILS
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

## Window Context Isolation

### The cy.window() Context Problem

One of the most subtle issues in Cypress tests is when state from one phase of a test "sticks" and affects later phases.

**Root Cause**: `cy.window()` blocks can hold onto state across different phases of a test.

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
      cy.get('#agreeButton').click() // State may be contaminated!
    })
})
```

✅ **Correct Pattern - Window Context Isolation:**

```javascript
it('admin and participant test', () => {
  let conversationId

  // Phase 1: Admin actions (isolated window context)
  cy.window().then(() => {
    loginStandardUserAPI('admin@polis.test', 'password')
    // ... admin operations ...
    conversationId = result.conversation_id
  })

  // Phase 2: Clean context for next phase
  cy.then(() => {
    // Visit neutral page to establish clean context
    cy.visit('/')

    // Now subsequent actions work correctly
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton').click() // Clean state!
  })
})
```

**Key Insight**: The critical fix is **isolating phases within their own `cy.window()` context** and using `cy.then()` to create a clean break.

### Intercept Persistence and Sticky Authentication

Another major cause of "sticky authentication" is persistent intercepts. Cypress intercepts are **additive** and persist for the entire test unless explicitly cleared.

❌ **Problem - Persistent Global Intercept:**

```javascript
// In admin setup phase
cy.intercept('**/api/**', (req) => {
  req.headers['Authorization'] = `Bearer ${adminToken}`
}).as('adminAuth')

// Later in participant phase
cy.visit('/conversation') // ALL requests still have admin auth!
```

✅ **Solution 1 - Use Specific Intercepts:**

```javascript
// Only intercept specific admin endpoints
cy.intercept('**/api/**', (req) => {
  if (req.url.includes('/conversations') || req.url.includes('/users')) {
    req.headers['Authorization'] = `Bearer ${adminToken}`
  }
}).as('adminAuth')
```

✅ **Solution 2 - Use Middleware Intercepts with Priority:**

```javascript
// High-priority intercept to clean participant requests
cy.intercept({ url: '**/api/**', middleware: true }, (req) => {
  if (req.url.includes('/participationInit')) {
    delete req.headers['Authorization']
    delete req.headers['Cookie']
  }
})
```

✅ **Solution 3 - Visit Neutral Page Between Phases:**

```javascript
// Break context between admin and participant phases
cy.visit('/404', { failOnStatusCode: false })
cy.clearAllCookies()
cy.clearAllLocalStorage()
cy.clearAllSessionStorage()
```

### Key Rules for Avoiding Sticky State

1. **Isolate test phases** with `cy.then()` blocks
2. **Use specific intercepts** instead of global wildcards
3. **Visit neutral pages** between different auth contexts
4. **Clear ALL storage types** (cookies, localStorage, sessionStorage)
5. **Use middleware intercepts** for high-priority header cleaning
6. **Delete window globals** that might hold auth state

## Command Best Practices

### Logging in Intercepts

When using `cy.intercept()`, remember:

- Use `console.log()` inside intercept callbacks for logging request details.
- Do not use `cy.log()` inside intercept callbacks, as they are not part of the Cypress command chain and will cause errors.

Example:

```javascript
cy.intercept('**/api/**', (req) => {
  console.log('Intercepting request:', req.url)
  console.log('Request headers:', req.headers)
  delete req.headers['Authorization']
}).as('cleanRequests')
```

For Cypress command chain logging, use `cy.log()` outside of intercept callbacks:

```javascript
cy.wait('@cleanRequests').then((interception) => {
  cy.log('Intercepted request:', interception.request.url)
})
```

### Variables and Aliases

❌ **Wrong - Variables don't update:**

```javascript
let token
cy.window().then((win) => {
  token = win.localStorage.getItem('participant_token_123') // conversation-specific key
})
// token is still undefined here!
expect(token).to.exist // FAILS
```

✅ **Correct - Use .then() chains:**

```javascript
cy.window().then((win) => {
  const token = win.localStorage.getItem('participant_token_123') // conversation-specific key
  expect(token).to.exist // Works!
})
```

✅ **Or use aliases:**

```javascript
cy.window()
  .then((win) => {
    return win.localStorage.getItem('participant_token_123') // conversation-specific key
  })
  .as('token')

// Later in the test
cy.get('@token').then((token) => {
  expect(token).to.exist
})
```

### Breaking Up Unsafe Command Chains

To avoid ESLint errors and improve readability:

❌ **Wrong - Unsafe chaining:**

```javascript
cy.get('input[data-testid="topic"]').clear().type(testTopic).blur()
```

✅ **Correct - Separate commands:**

```javascript
cy.get('input[data-testid="topic"]').clear()
cy.get('input[data-testid="topic"]').type(testTopic)
cy.get('input[data-testid="topic"]').blur()
```

### Sync/Async Mixing in Helper Functions

❌ **Wrong - Mixing sync returns with Cypress commands:**

```javascript
function createConversation(topic) {
  cy.request({
    method: 'POST',
    url: '/api/v3/conversations',
    body: { topic },
  }).then((response) => {
    cy.log('Created conversation') // Cypress command
    return response.body.conversation_id // Sync return - BAD!
  })
}
```

✅ **Correct - Return Cypress chainable:**

```javascript
function createConversation(topic) {
  return cy
    .request({
      method: 'POST',
      url: '/api/v3/conversations',
      body: { topic },
    })
    .then((response) => {
      const conversationId = response.body.conversation_id
      cy.log(`Created conversation: ${conversationId}`)
      return cy.wrap(conversationId) // Return Cypress chainable
    })
}
```

## Debugging Tips

### Using .only() for Focused Testing

```javascript
// Focus on single describe block
describe.only('Create New Conversation', () => {
  // Only this block runs
})

// Focus on single test
it.only('should create a new conversation', () => {
  // Only this test runs
})
```

**Remember to remove `.only()` after testing!**

### Custom Cypress Commands

For cleaner test code, create reusable commands:

```javascript
// Get iframe body with better error handling
cy.getIframeBody('iframe[data-testid="polis-iframe"]')

// Instead of manually accessing iframe documents
cy.get('iframe').then(($iframe) => {
  const iframeDoc = $iframe[0].contentDocument
  cy.wrap(iframeDoc).within(() => {
    /* ... */
  })
})
```

### Waiting Strategies

1. **Wait for element visibility with timeout:**

   ```javascript
   cy.get('pre').should('be.visible').should('not.contain', 'loading, try refreshing') // Wait for actual content
   ```

2. **Wait for API responses:**

   ```javascript
   cy.intercept('POST', '/api/v3/comments').as('addComment')
   cy.get('button').contains('Submit').click()
   cy.wait('@addComment') // Wait for request to complete
   ```

3. **Add timeout for slow-loading elements:**

   ```javascript
   cy.contains('h1, h2, h3', section.name, { timeout: 10000 }).should('be.visible')
   ```

## Code Maintenance

### Before Removing Functions

**Always search before removing ANY exported function:**

```bash
grep -r "functionName" e2e/
```

Only remove if the search returns no results across the entire e2e directory.

### Test Data Management

1. **Use predictable test data:**

   ```javascript
   before(() => {
     // Create known test data
     createTestConversationAPI({
       topic: 'Pre-existing Test Conversation',
       description: 'This conversation exists before each test runs',
     }).then((convId) => {
       preExistingConversationId = convId
     })
   })
   ```

2. **Clean up between tests:**

   ```javascript
   beforeEach(() => {
     cy.clearAllCookies()
     cy.clearAllLocalStorage()
     cy.clearAllSessionStorage()
   })
   ```

### Error Handling

1. **Check for element existence before interaction:**

   ```javascript
   cy.get('body').then(($body) => {
     if ($body.find('#agreeButton').length > 0) {
       cy.get('#agreeButton').click()
     } else {
       cy.log('Vote button not found - skipping vote')
     }
   })
   ```

2. **Handle different response structures:**

   ```javascript
   cy.wait('@apiCall').then((interception) => {
     const data = Array.isArray(interception.response.body)
       ? interception.response.body[0]
       : interception.response.body
     // Use data...
   })
   ```

## Summary

These patterns help avoid common Cypress pitfalls:

1. **Never mix sync/async code** - Always return Cypress chainables from `.then()` callbacks
2. **Isolate test phases** using `cy.window()` contexts to prevent state contamination
3. **Use `.should()` for assertions only**, `.then()` for commands and debugging
4. **Be careful with `cy.intercept()`** callbacks - they change how `cy.wait()` works
5. **Always search before removing functions** from helper files
6. **Create predictable test data** and clean up between tests
7. **Use conversation-specific JWT keys** - JWT tokens are stored as `participant_token_${conversationId}`

## JWT Storage Pattern

**Important**: JWT tokens are now stored conversation-specifically as `participant_token_${conversationId}`. This allows participants to maintain multiple JWTs simultaneously for different conversations.

```javascript
// Get JWT for specific conversation
cy.window().then((win) => {
  const conversationId = 'abc123'
  const token = win.localStorage.getItem(`participant_token_${conversationId}`)
  expect(token).to.exist
})

// Helper function to get conversation-specific JWT
function getConversationJWT(conversationId) {
  return cy.window().then((win) => {
    return win.localStorage.getItem(`participant_token_${conversationId}`)
  })
}
```

### Key Changes

The client apps now store JWT tokens conversation-specifically as `participant_token_${conversationId}` instead of a single `participant_token`. This allows:

- **Multiple conversations**: Participants can maintain JWTs for multiple conversations simultaneously
- **Better isolation**: Tests can run multiple conversation scenarios without JWT conflicts
- **Realistic behavior**: Matches how users actually interact with multiple conversations

### Updated Test Patterns

```javascript
// Old pattern (no longer works)
cy.window().then((win) => {
  const token = win.localStorage.getItem('participant_token')
})

// New pattern (conversation-specific)
cy.window().then((win) => {
  const token = win.localStorage.getItem(`participant_token_${conversationId}`)
})

// Helper function approach
function getConversationJWT(conversationId) {
  return cy.window().then((win) => {
    return win.localStorage.getItem(`participant_token_${conversationId}`)
  })
}
```

### Testing Multiple Conversations

```javascript
it('should handle multiple conversations', () => {
  // Setup two conversations
  const conv1 = 'abc123'
  const conv2 = 'def456'

  // Visit first conversation and vote
  cy.visit(`/${conv1}`)
  voteOnComment('agree')
  waitForJWTToken(`participant_token_${conv1}`)

  // Visit second conversation and vote
  cy.visit(`/${conv2}`)
  voteOnComment('agree')
  waitForJWTToken(`participant_token_${conv2}`)

  // Both JWTs should exist independently
  cy.window().then((win) => {
    expect(win.localStorage.getItem(`participant_token_${conv1}`)).to.exist
    expect(win.localStorage.getItem(`participant_token_${conv2}`)).to.exist
  })
})
```

For specific authentication patterns, see [E2E-AUTHENTICATION-GUIDE.md](./E2E-AUTHENTICATION-GUIDE.md).
For participant testing patterns, see [PARTICIPANT-TESTING.md](./PARTICIPANT-TESTING.md).
For embed testing patterns, see [EMBED-TESTING.md](./EMBED-TESTING.md).
