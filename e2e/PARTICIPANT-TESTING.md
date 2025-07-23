# Participant Authentication E2E Testing

This document explains the improved e2e testing approach for participant authentication that aligns with how the system actually works.

**Note**: For general Cypress patterns and best practices, see [BEST-PRACTICES.md](./BEST-PRACTICES.md).

## Key Insights

### How Participant Authentication Actually Works

1. **Anonymous participants don't "log in"** - They receive JWT tokens when they take actions like voting
2. **No default home page** - Participants access specific conversation URLs like `/9t6ra4ikkf`
3. **Conversations must exist first** - Created by authenticated users (moderators/admins) before participant testing
4. **JWT issuance is action-triggered** - Tokens are issued when participants vote, not when they visit

### Critical: Avoiding Sticky Authentication

When tests combine admin setup with participant actions, admin authentication can "stick" and cause participants to be incorrectly identified as admin users. This is covered in detail in [Window Context Isolation](./BEST-PRACTICES.md#window-context-isolation) in the best practices guide.

**Key Pattern:**

```javascript
// Admin phase (isolated)
cy.window().then(() => {
  // Admin setup code
})

// Participant phase (clean context)
cy.then(() => {
  // Participant code
})
```

### What Changed

#### Before (Incorrect Approach)

```javascript
// ❌ This was wrong - anonymous participants don't "log in"
export function loginAnonymousParticipant() {
  cy.visit('/') // ❌ No home page for participants
  cy.wrap(win.localStorage).should('contain.key', 'participant_token_123') // ❌ No token until action
}
```

#### After (Correct Approach)

```javascript
// ✅ This is correct - participants receive JWTs when they take actions
export function participateAnonymously(conversationId) {
  cy.visit(`/${conversationId}`) // ✅ Visit specific conversation
  // JWT will be issued when participant votes, not immediately
  // JWT is stored as participant_token_${conversationId}
}
```

## New Helper Functions

### Conversation Helpers (`conversation-helpers.js`)

- `setupTestConversation()` - Creates conversation with comments for testing
- `createTestConversation()` - Creates a basic test conversation
- `addCommentToConversation()` - Adds comments to existing conversation
- `visitConversationAsParticipant()` - Visits conversation as participant

### Updated Auth Helpers (`auth-helpers.js`)

- `participateAnonymously(conversationId)` - Replaces misleading "loginAnonymousParticipant"
- `participateWithXID(conversationId, xid)` - Replaces "loginXIDParticipant"
- `voteOnComment(voteType, commentIndex)` - Triggers JWT issuance by voting
- `verifyJWTExists(tokenKey, expectedClaims)` - Verifies JWT structure and claims
- `waitForJWTToken(tokenKey)` - Waits for JWT to be stored after actions

**Note**: JWT tokens are now stored conversation-specifically as `participant_token_${conversationId}`. Helper functions should be called with the conversation-specific key.

## Test Flow Pattern

### 1. Setup Phase

```javascript
before(() => {
  // Create test conversation with comments
  setupTestConversation({
    topic: 'Test Conversation',
    comments: ['Comment 1', 'Comment 2', 'Comment 3'],
  }).then((conversation) => {
    testConversation = conversation
  })
})
```

### 2. Anonymous Participant Testing

```javascript
it('should issue JWT when anonymous participant votes', () => {
  // Visit conversation (no JWT yet)
  visitConversationAsParticipant(testConversation.conversationId)

  // Vote to trigger JWT issuance
  voteOnComment('agree', 0)

  // Wait for and verify JWT (conversation-specific)
  waitForJWTToken(`participant_token_${testConversation.conversationId}`)
  verifyJWTExists(`participant_token_${testConversation.conversationId}`, {
    anonymous_participant: true,
    conversation_id: testConversation.conversationId,
  })
})
```

### 3. XID Participant Testing

```javascript
it('should issue JWT when XID participant votes', () => {
  const testXid = `test-xid-${Date.now()}`

  // Visit with XID parameter (no JWT yet)
  visitConversationAsParticipant(testConversation.conversationId, { xid: testXid })

  // Vote to trigger JWT issuance
  voteOnComment('agree', 0)

  // Wait for and verify JWT (conversation-specific)
  waitForJWTToken(`participant_token_${testConversation.conversationId}`)
  verifyJWTExists(`participant_token_${testConversation.conversationId}`, {
    xid: testXid,
    conversation_id: testConversation.conversationId,
  })
})
```

## Running the Tests

```bash
# Run all e2e tests
npm run test

# Run only participant authentication tests
npx cypress run --spec "cypress/e2e/auth/participant-authentication.cy.js"

# Open Cypress UI for debugging
npm run cy:open
```

## Test Environment Requirements

### OIDC Simulator

- Must be running for standard user authentication
- Used to create conversations and comments
- Default test users: `moderator@polis.test`, `admin@polis.test`

### Environment Variables

```bash
# OIDC configuration
AUTH_ISSUER=https://localhost:3000/
AUTH_CLIENT_ID=dev-client-id
AUTH_AUDIENCE=users
AUTH_NAMESPACE=https://pol.is/

# Development server
CYPRESS_BASE_URL=http://localhost:5000
```

## Key Test Scenarios Covered

### Anonymous Participants

- ✅ Visit conversation without initial JWT
- ✅ Receive JWT when voting for the first time
- ✅ Use JWT for subsequent API requests
- ✅ JWT persists across page refreshes
- ✅ JWT validates correctly on server
- ✅ JWT stored conversation-specifically (`participant_token_${conversationId}`)

### XID Participants

- ✅ Visit conversation with XID parameter
- ✅ Receive XID JWT when voting
- ✅ Maintain XID identity across sessions
- ✅ Handle different XID formats
- ✅ XID JWT validates correctly on server
- ✅ JWT stored conversation-specifically (`participant_token_${conversationId}`)

### JWT Validation

- ✅ Valid JWT signatures accepted by server
- ✅ Invalid JWT tokens rejected
- ✅ JWT tokens scoped to specific conversations
- ✅ Multiple conversation JWTs can coexist simultaneously

## Benefits of New Approach

1. **Realistic Testing** - Tests match actual user behavior
2. **Reliable Setup** - Conversations exist before participant testing
3. **Clear Flow** - Explicit JWT issuance verification
4. **Better Coverage** - Tests both anonymous and XID scenarios
5. **Easier Debugging** - Clear logging and error messages

## Common Issues & Solutions

### JWT Not Issued

- **Cause**: Vote request failed or response not parsed
- **Solution**: Check browser network tab, verify conversation exists

### Test Timeouts

- **Cause**: Waiting for non-existent elements
- **Solution**: Adjust selectors in `voteOnComment()` function

### Conversation Not Found

- **Cause**: Test conversation creation failed
- **Solution**: Verify OIDC simulator is running and user credentials are correct

### Cross-Conversation JWT Issues

- **Cause**: JWT tokens are conversation-scoped
- **Solution**: Create separate JWTs for each conversation test
- **Note**: JWT tokens are now stored conversation-specifically, so multiple conversations can be tested simultaneously without conflicts
