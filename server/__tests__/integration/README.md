# Integration Tests

This directory contains integration tests for the Polis API. These tests verify the correctness of API endpoints by making actual HTTP requests to the server and checking the responses.

## Structure

Each test file focuses on a specific aspect of the API:

- `auth.test.js` - Authentication endpoints
- `comment.test.js` - Comment creation and retrieval endpoints
- `conversation.test.js` - Conversation creation and management endpoints
- `health.test.js` - Health check endpoints
- `participation.test.js` - Participation and initialization endpoints
- `tutorial.test.js` - Tutorial step tracking endpoints
- `vote.test.js` - Voting endpoints

## Shared Test Helpers

To maintain consistency and reduce duplication, all test files use shared helper functions from `__tests__/setup/api-test-helpers.js`. These include:

### Data Generation Helpers

- `generateTestUser()` - Creates random user data for registration
- `generateRandomXid()` - Creates random external IDs for testing

### Entity Creation Helpers

- `createConversation()` - Creates a conversation with the specified options
- `createComment()` - Creates a comment in a conversation
- `registerAndLoginUser()` - Registers and logs in a user in one step

### Participation and Voting Helpers

- `initializeParticipant()` - Initializes an anonymous participant for voting
- `initializeParticipantWithXid()` - Initializes a participant for voting with an external ID
- `submitVote()` - Submits a vote on a comment
- `getVotes()` - Retrieves votes for a conversation
- `getMyVotes()` - Retrieves a participant's votes

### Response Handling Utilities

- `validateResponse()` - Validates API responses with proper status and property checks
- `formatErrorMessage()` - Formats error messages consistently from API responses
- `hasResponseProperty()` - Safely checks for properties in responses (handles falsy values correctly)
- `getResponseProperty()` - Safely gets property values from responses (handles falsy values correctly)
- `extractCookieValue()` - Extracts a cookie value from response headers

### Test Setup Helpers

- `setupAuthAndConvo()` - Sets up authentication, creates a conversation, and comments in one step
- `wait()` - Pauses execution for a specified time

## Response Handling

The test helpers are designed to handle various quirks of the legacy server:

- **Content-Type Mismatches**: The legacy server sometimes sends plain text responses with `content-type: application/json`. Our test helpers handle this by attempting JSON parsing first, then falling back to raw text.
  
- **Error Response Format**: Error responses are often plain text error codes (e.g., `polis_err_param_missing_password`) rather than structured JSON objects. The test helpers check for both formats.

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

### Available Global Agents

Two pre-configured test agents are available globally in all test files:

- `global.__TEST_AGENT__`: A standard Supertest agent that maintains cookies across requests
- `global.__TEXT_AGENT__`: A specialized agent that properly handles text responses with JSON content-type

### Using the Global Agents

Import the global agents in your test files:

```javascript
describe('My API Test', () => {
  // Access the global agents
  const agent = global.__TEST_AGENT__;
  const textAgent = global.__TEXT_AGENT__;
  
  test('Test with JSON responses', async () => {
    // Use standard agent for proper JSON responses
    const response = await agent.get('/api/v3/conversations');
    expect(response.status).toBe(200);
  });
  
  test('Test with text/error responses', async () => {
    // Use text agent for endpoints that return text errors
    const response = await textAgent.post('/api/v3/auth/login').send({});
    expect(response.status).toBe(400);
    expect(response.text).toContain('polis_err_param_missing_password');
  });
});
```

### Helper Functions

You can use these standalone helper functions:

- `makeTextRequest(app, method, path)`: Creates a single request with text parsing
- `createTextAgent(app)`: Creates an agent with text parsing
- `authenticateAgent(agent, token)`: Authenticates a single agent with a token
- `authenticateGlobalAgents(token)`: Authenticates both global agents with the same token
- `parseResponseJSON(response)`: Safely parses JSON response objects

And these agent-based versions of common test operations:

- `createComment(agent, conversationId, options)`: Creates a comment using an agent
- `createConversation(agent, options)`: Creates a conversation using an agent
- `getComments(agent, conversationId, options)`: Gets comments using an agent
- `submitVote(agent, options)`: Submits a vote using an agent
- `setupAuthAndConvo(options)`: Sets up auth and creates a conversation using agents

See `__tests__/integration/example-global-agent.test.js` for a full example of this pattern.

### Best Practices

1. First determine if a `.test.supertest.js` version should be created for parallel testing, or if the original file should be updated directly.

2. Replace direct `http` or `request` imports with the global agents:

```javascript
// Access the global agents
const agent = global.__TEST_AGENT__; // For JSON responses 
const textAgent = global.__TEXT_AGENT__; // For handling text responses
```

3. Replace direct HTTP requests with agent requests:

```javascript
// Before:
const response = await makeRequest('GET', '/conversations', null, authToken);

// After:
const response = await agent.get('/api/v3/conversations');
```

4. Be careful with response handling:
   - Use `JSON.parse(response.text)` instead of `response.body` if needed
   - For text responses, use `response.text` directly
   - Use `textAgent` for endpoints that might return text errors

5. Ensure cookies are properly handled when sharing sessions:

```javascript
// Set cookies on the agent
const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
agent.set('Cookie', cookieString);
```

- Use `textAgent` for endpoints that might return error messages as text, even with a JSON content-type
- Use `agent` for endpoints that reliably return valid JSON
- For requests that need both cookie persistence and text handling, set the cookies on both agents
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

- Global agent instances are stored in `global.__TEST_AGENT__` and `global.__TEXT_AGENT__`
- Helper functions `getTestAgent()` and `getTextAgent()` ensure agents are always available
- Lazy initialization creates agents only when needed

### 2. Lifecycle Management

- `globalSetup.js` creates a test server on a dynamic port and initializes agents if needed
- `globalTeardown.js` closes the server but preserves agent instances
- This allows agents to maintain their state (cookies, etc.) across test files

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
