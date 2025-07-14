# Integration Tests

This directory contains integration tests for the Polis API. These tests verify the correctness of API endpoints by making actual HTTP requests to the server and checking the responses.

## Authentication Architecture

As of the OIDC JWT migration, the API supports multiple authentication methods in priority order:

1. **OIDC JWT** (preferred for standard users)
2. **XID JWT** (for external integrations)  
3. **Anonymous JWT** (for anonymous participants)
4. **Legacy methods** (cookies, API keys) - deprecated, used as fallback

### OIDC Simulator Requirement

**Important**: Integration tests require the OIDC simulator to be running for JWT authentication tests.

```bash
# Start the OIDC simulator (from project root)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up oidc-simulator

# Or if using the full development stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The simulator provides pre-registered test users that are compatible with JWT authentication tests.

## Structure

Each test file focuses on a specific aspect of the API:

- `auth-jwt.test.ts` - OIDC JWT authentication
- `xid-auth.test.ts` - XID JWT authentication
- `anonymous-jwt.test.ts` - Anonymous JWT authentication
- `auth.test.ts` - Legacy authentication endpoints (deprecated)
- `comment.test.ts` - Comment creation and retrieval endpoints
- `conversation.test.ts` - Conversation creation and management endpoints
- `conversation-details.test.ts` - Conversation details and stats endpoints
- `conversation-preload.test.ts` - Conversation preload information
- `health.test.ts` - Health check endpoints
- `participation.test.ts` - Participation and initialization endpoints
- `tutorial.test.ts` - Tutorial step tracking endpoints
- `vote.test.ts` - Voting endpoints
- `routes-jwt-validation.test.ts` - Comprehensive route authentication validation

## Authentication Patterns

### JWT Authentication (Recommended)

For tests that need authenticated users, use the JWT authentication pattern:

```typescript
import { getJwtAuthenticatedAgent } from '../setup/api-test-helpers';
import { getPooledTestUser } from '../setup/test-user-helpers';

describe('My Authenticated Test', () => {
  let agent: Agent;

  beforeEach(async () => {
    // Use pooled users (pre-registered in OIDC simulator)
    const pooledUser = getPooledTestUser(1);
    const testUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    
    // Get JWT authenticated agent
    const { agent: jwtAgent } = await getJwtAuthenticatedAgent(testUser);
    agent = jwtAgent;
  });

  test('should work with JWT auth', async () => {
    const response = await agent.post('/api/v3/conversations').send({
      topic: 'Test Conversation'
    });
    expect(response.status).toBe(200);
  });
});
```

### XID Authentication

For external integration tests:

```typescript
import { getXidAuthenticatedAgent } from '../setup/xid-jwt-test-helpers';

describe('XID Integration Test', () => {
  test('should work with XID JWT', async () => {
    const { agent } = await getXidAuthenticatedAgent({
      xid: 'test-external-user',
      ownerUid: 1
    });
    
    const response = await agent.get('/api/v3/some-endpoint');
    expect(response.status).toBe(200);
  });
});
```

### Anonymous Participation

For anonymous user tests:

```typescript
import { initializeParticipant } from '../setup/api-test-helpers';

describe('Anonymous Participation Test', () => {
  test('should initialize anonymous participant', async () => {
    const { agent, token } = await initializeParticipant(conversationId);
    
    // Agent is automatically configured with JWT token
    const response = await agent.post('/api/v3/votes').send(voteData);
    expect(response.status).toBe(200);
  });
});
```

### Legacy Authentication (Deprecated)

**⚠️ Deprecated**: Avoid using `registerAndLoginUser()` for new tests. This pattern uses legacy cookie authentication which is being phased out.

```typescript
// ❌ Don't use this pattern for new tests
const auth = await registerAndLoginUser();
const agent = auth.agent;

// ✅ Use JWT authentication instead  
const { agent } = await getJwtAuthenticatedAgent(testUser);
```

## Shared Test Helpers

To maintain consistency and reduce duplication, all test files use shared helper functions from `__tests__/setup/api-test-helpers.ts`. These include:

### Authentication Helpers

- `getJwtAuthenticatedAgent(testUser)` - Creates an agent with OIDC JWT authentication
- `getOidcToken(user)` - Gets an OIDC token from the simulator
- `setAgentJwt(agent, token)` - Sets JWT authorization header on an existing agent

### User Management Helpers

- `getPooledTestUser(index)` - Gets a pre-registered test user from the OIDC simulator

### Data Generation Helpers

- `generateRandomXid()` - Creates random external IDs for testing

### Entity Creation Helpers

- `createConversation(agent, options)` - Creates a conversation with the specified options
- `createComment(agent, conversationId, options)` - Creates a comment in a conversation
- `registerAndLoginUser(userData)` - **Deprecated**: Registers and logs in a user with cookies

### Participation and Voting Helpers

- `initializeParticipant(conversationId)` - Initializes an anonymous participant (now returns JWT)
- `initializeParticipantWithXid(conversationId, xid)` - Initializes a participant with external ID (now returns JWT)
- `submitVote(agent, options)` - Submits a vote on a comment

### Response Handling Utilities

- `validateResponse(response, options)` - Validates API responses with proper status and property checks
- `formatErrorMessage(response, prefix)` - Formats error messages consistently from API responses
- `hasResponseProperty(response, propertyPath)` - Safely checks for properties in responses (handles falsy values correctly)


### Test Setup Helpers

- `setupAuthAndConvo(options)` - **Updated**: Now uses JWT authentication by default
  - Automatically clears domain whitelist for test users to avoid domain restrictions
  - Creates conversations with sensible defaults for testing
  - Returns user ID, conversation ID, and comment IDs
- `wait(ms)` - Pauses execution for a specified time

## Migration Considerations

When updating existing tests to use JWT authentication:

1. **Replace authentication setup**:

   ```typescript
   // Before
   const auth = await registerAndLoginUser();
   const agent = auth.agent;
   
   // After  
   const { agent } = await getJwtAuthenticatedAgent(testUser);
   ```

2. **Use pooled users** for OIDC simulator compatibility:

   ```typescript
   const pooledUser = getPooledTestUser(1); // Users 1-3 are available
   const testUser = {
     email: pooledUser.email,
     hname: pooledUser.name, 
     password: pooledUser.password,
   };
   ```

3. **Update test lifecycle**: Consider using `beforeEach` instead of `beforeAll` for better test isolation with fresh JWT tokens.

4. **Check endpoint authentication**: Some endpoints that previously worked without authentication now require JWT due to the `hybridAuth()` middleware.

## Response Handling

The test helpers are designed to handle various quirks of the legacy server:

- **Consistent JSON Responses**: The server now sends proper JSON responses for all endpoints, eliminating content-type mismatches.
  
- **Error Response Format**: Error responses are now properly structured JSON objects with error codes.

- **Gzip Compression**: Some responses are gzipped, either with or without proper `content-encoding: gzip` headers. The helpers automatically detect and decompress gzipped content.

- **Falsy ID Values**: Special care is taken to handle IDs that might be 0 (which is a valid value but falsy in JavaScript), preventing false negative checks.

### Email Testing

The `email-helpers.js` file provides utilities for testing email functionality:

- **Finding Emails**: `findEmailByRecipient()` locates emails sent to specific recipients
- **Email Cleanup**: `deleteAllEmails()` removes all emails before and after tests
- **Content Extraction**: Functions to extract specific content like reset URLs from emails
- **Polling Mechanism**: Retry and timeout functionality to allow for email delivery delays

These helpers are used in tests that verify email-based functionality like:

- User invitations
- Password resets
- Notifications

To use the email testing capabilities, ensure MailDev is running (included in the docker-compose setup) and accessible at <http://localhost:1080>.

## Global Test Agent Pattern

To simplify API testing and handle various response types properly, we've implemented a global test agent pattern:

### Available Global Agent

A pre-configured test agent is available globally in all test files:

- `global.__TEST_AGENT__`: A standard Supertest agent that maintains auth across requests


### Using the Global Agent

Import the global agent in your test files:

```javascript
describe('My API Test', () => {
  // Access the global agent
  const agent = global.__TEST_AGENT__;
  
  test('Test with JSON responses', async () => {
    // All endpoints now return proper JSON
    const response = await agent.get('/api/v3/conversations');
    expect(response.status).toBe(200);
  });
  
  test('Test with error responses', async () => {
    // Error responses are now JSON
    const response = await agent.post('/api/v3/auth/login').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('polis_err_param_missing_password');
  });
});
```

### Helper Functions

You can use these standalone helper functions:

- `authenticateAgent(agent, token)`: Authenticates a single agent with a token


And these agent-based versions of common test operations:

- `createComment(agent, conversationId, options)`: Creates a comment using an agent
- `createConversation(agent, options)`: Creates a conversation using an agent
- `getComments(agent, conversationId, options)`: Gets comments using an agent
- `submitVote(agent, options)`: Submits a vote using an agent
- `setupAuthAndConvo(options)`: Sets up auth and creates a conversation using agents

See `__tests__/integration/example-global-agent.test.js` for a full example of this pattern.

### Best Practices

1. **Choose the right authentication method**: Use JWT authentication (`getJwtAuthenticatedAgent`) for new tests unless specifically testing legacy functionality.

2. **Use pooled users** for Auth0 compatibility:

   ```typescript
   const pooledUser = getPooledTestUser(Math.floor(Math.random() * 3) + 1);
   ```

3. Replace direct `http` or `request` imports with the global agent pattern:

```javascript
// Access the global agent
const agent = global.__TEST_AGENT__;
```

4. Replace direct HTTP requests with agent requests:

```javascript
// Before:
const response = await makeRequest('GET', '/conversations', null, authToken);

// After:
const response = await agent.get('/api/v3/conversations');
```

5. Be careful with response handling:
   - All responses now return proper JSON
   - Access JSON data with `response.body`
   - Error responses are also JSON objects

6. **Handle authentication errors properly**: With JWT authentication, expect 401 "Unauthorized" for missing/invalid tokens and 403 "Forbidden" for insufficient permissions.

7. **URL construction**:
   - Use template literals for URL parameters: `` `/api/v3/nextComment?conversation_id=${conversationId}` ``
   - Don't forget the `/api/v3` prefix in routes when using the agents directly

### Running Tests

You can now run multiple test files without port conflicts:

```bash
npm test -- __tests__/integration/comment.test.js
npm test -- __tests__/integration/vote.test.js
```

Or run all integration tests at once:

```bash
npm test -- __tests__/integration
```

Or, simply:

```bash
npm run test:integration
```

### Implementation Details

The key changes were:

1. Created `index.js` with a `startServer()` function
2. Updated `app.js` to only export the configured app
3. Modified `globalSetup.js` to start a server on a random port
4. Enhanced `globalTeardown.js` to properly close the server
5. Updated test helpers to use the dynamic port

## Shared Test Agents

To improve test reliability and performance, we use shared test agents across all test files. This is implemented using two key techniques:

### 1. Global Agents with Lazy Initialization

- Global agent instance is stored in `global.__TEST_AGENT__`
- Helper function `getTestAgent()` ensures the agent is always available
- Lazy initialization creates agents only when needed

### 2. Lifecycle Management

- `globalSetup.js` creates a test server on a dynamic port and initializes agents if needed
- `globalTeardown.js` closes the server but preserves agent instances
- This allows agents to maintain their state (auth, etc.) across test files

### Using Agents in Tests

Always use the getter functions to access agents:

```javascript
import { getTestAgent } from '../setup/api-test-helpers.js';

describe('My Test Suite', () => {
  test('My Test', async () => {
    const agent = await getTestAgent();
    const response = await agent.get('/api/v3/endpoint');
    expect(response.status).toBe(200);
  });
});
```

Or use the helper functions that utilize agents internally:

```javascript
import { createComment, getTestAgent } from '../setup/api-test-helpers.js';

describe('My Test Suite', () => {
  test('My Test', async () => {
    const agent = await getTestAgent();
    const commentId = await createComment(agent, conversationId, { txt: 'Test comment' });
    expect(commentId).toBeDefined();
  });
});
```

## Troubleshooting

### Common Issues

1. **OIDC Simulator not running**: Ensure
   `docker compose -f docker-compose.yml -f docker-compose.dev.yml up oidc-simulator`
   is running before tests.

2. **JWT validation failures**: Check that environment variables are set correctly:

   ```bash
   AUTH_ISSUER=https://localhost:3000/
   AUTH_AUDIENCE=users
   JWKS_URI=https://localhost:3000/.well-known/jwks.json
   ```

3. **User not found errors**: Use `getPooledTestUser()` for Auth0 compatibility
4. **401 vs 403 errors**: 401 means missing/invalid JWT, 403 means valid JWT but insufficient permissions

5. **Domain whitelist errors (403 polis_err_domain)**: The `participationInit` endpoint requires a valid referrer domain. The test helpers now automatically set a default origin that matches the whitelisted domains. You can override this if needed:

   ```typescript
       // Default behavior - uses dynamic test server URL automatically
    const { agent } = await initializeParticipant(conversationId);
   
   // Override with custom origin if needed
   const { agent } = await initializeParticipant(conversationId, { 
     origin: 'http://custom-domain.com' 
   });
   ```

### Migration Checklist

When updating a test file to use JWT authentication:

- [x] Replace `registerAndLoginUser()` with `getJwtAuthenticatedAgent()`
- [x] Import `getPooledTestUser` and use pooled users
- [x] Update imports to include new JWT helpers
- [ ] Change `beforeAll` to `beforeEach` if test isolation is needed
- [ ] Update error expectations (401 for auth failures, not 403)
- [x] Test that the OIDC simulator is running and accessible
