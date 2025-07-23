# JWT Test Setup for Anonymous Participants

## Context

The anonymous JWT flow works correctly in the browser but fails in Cypress tests. This is because:

1. JWT keys ARE properly configured in the server (via docker mount of `AUTH_KEYS_PATH`, or `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` environment variables)
2. The browser successfully receives JWT tokens when voting
3. The Cypress test environment might be missing something that the browser has

## How JWT Flow Works

1. Anonymous user visits conversation
2. `/api/v3/participationInit` is called - NO JWT is issued at this point
3. User casts their first vote via `/api/v3/votes`
4. Server issues JWT token in the vote response
5. Client stores JWT in localStorage as `participant_token_${conversationId}` (conversation-specific)
6. Subsequent requests include JWT in Authorization header

## The Real Issue

Since the server has JWT keys (evidenced by browser working), the test failure is likely due to:

1. **Client-side storage**: The test might be checking for JWT storage before the client has processed it
2. **Timing**: The client's JWT storage might be asynchronous
3. **Intercepts**: Cypress intercepts might be interfering with the normal flow

## Running the Test

```bash
# From the e2e directory
npm test -- --spec cypress/e2e/client-participation/anonymous-jwt-flow.cy.js
```

## Debugging Tips

1. Check if the server has JWT keys configured:

   ```bash
   docker exec polis-dev-server-1 ls -la /app/keys/
   ```

2. Monitor server logs during test:

   ```bash
   docker logs -f polis-dev-server-1 | grep -i jwt
   ```

3. Check browser developer tools:
   - Network tab: Look for `/api/v3/votes` response with `auth.token` field
   - Application tab: Check localStorage for `participant_token_${conversationId}` (conversation-specific)

## Test Improvements

The updated test now:

1. Monitors localStorage.setItem calls to catch JWT storage with conversation-specific keys
2. Uses a Promise to wait for asynchronous JWT storage
3. Verifies JWT is used in subsequent requests
4. Provides better debugging output
5. Handles conversation-specific JWT storage pattern (`participant_token_${conversationId}`)
