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

## Command Best Practices

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
    body: { topic }
  }).then((response) => {
    cy.log('Created conversation') // Cypress command
    return response.body.conversation_id // Sync return - BAD!
  })
}
```

✅ **Correct - Return Cypress chainable:**

```javascript
function createConversation(topic) {
  return cy.request({
    method: 'POST',
    url: '/api/v3/conversations',
    body: { topic }
  }).then((response) => {
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
   cy.get('pre')
     .should('be.visible')
     .should('not.contain', 'loading, try refreshing') // Wait for actual content
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
       description: 'This conversation exists before each test runs'
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

For specific authentication patterns, see [E2E-AUTHENTICATION-GUIDE.md](./E2E-AUTHENTICATION-GUIDE.md).
For participant testing patterns, see [PARTICIPANT-TESTING.md](./PARTICIPANT-TESTING.md).
For embed testing patterns, see [EMBED-TESTING.md](./EMBED-TESTING.md).
