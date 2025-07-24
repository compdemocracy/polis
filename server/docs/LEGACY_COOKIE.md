# Legacy Cookie Authentication

## Overview

Legacy cookie authentication provides backward compatibility for existing Polis participants who have permanent cookies (`pc` cookie) from the previous authentication system. This feature ensures a smooth transition to JWT-based authentication without requiring users to re-authenticate or lose their participant history.

## How It Works

### Authentication Flow

1. **Request with Legacy Cookie**:

   ```
   GET /api/v3/participationInit?conversation_id=abc
   Cookie: pc=abc123def456...
   ```

2. **Server Lookup**:
   - Server checks for the `pc` cookie in the request
   - Queries the database to find the participant associated with this permanent cookie
   - If found, retrieves the existing `uid` and `pid`

3. **JWT Issuance**:
   - Issues an appropriate JWT token (Anonymous or XID) for the existing participant
   - Returns the JWT in the response's `auth` field
   - Client stores the JWT for future requests

4. **Subsequent Requests**:
   - Client uses the JWT for authentication
   - Legacy cookie is no longer needed

### Database Schema

The permanent cookies are stored in the `participants_extended` table:

```sql
-- Lookup query used by the system
SELECT pe.uid, p.pid 
FROM participants_extended pe
INNER JOIN participants p ON pe.uid = p.uid AND pe.zid = p.zid
WHERE pe.zid = $1 AND pe.permanent_cookie = $2
```

## Implementation Details

### Server-Side Components

**`src/auth/legacyCookies.ts`**:

- Core logic for checking legacy cookies
- Issues appropriate JWT tokens for existing participants

**Route Integration**:

- `/api/v3/votes` - Checks for legacy cookie before creating new participants
- `/api/v3/comments` - Supports legacy cookie authentication for comment submission
- `/api/v3/participationInit` - Recognizes existing participants via legacy cookie

### Response Format

When a legacy cookie is recognized, the response includes a JWT:

```json
{
  "auth": {
    "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...",
    "token_type": "Bearer",
    "expires_in": 31536000
  },
  "currentPid": 123,
  // ... other response data
}
```

## Security Considerations

- **No New Cookies**: The system does not issue new permanent cookies
- **One-Way Migration**: Once a participant receives a JWT, they should use it for future requests
- **Conversation Scoping**: Legacy cookies are validated against specific conversations
- **Limited Lifespan**: This is a transitional feature that can be removed once migration is complete

## Testing

### Integration Tests

See `server/__tests__/integration/legacy-cookie.test.ts` for comprehensive tests covering:

- Participant recognition via permanent cookie
- JWT issuance for legacy participants
- XID participant handling with legacy cookies
- New participant creation when cookie is invalid

### E2E Tests

See `e2e/cypress/e2e/client-participation/legacy-cookie-auth.cy.js` for browser-based tests covering:

- Permanent cookie detection
- JWT issuance verification
- Identity preservation across authentication methods
- All endpoint support (votes, comments, participationInit)

## Migration Timeline

1. **Current**: Legacy cookie support active, JWTs issued for existing participants
2. **Monitoring Phase**: Track usage of legacy cookies vs JWTs
3. **Deprecation Notice**: Inform integrations about upcoming removal
4. **Removal**: Remove legacy cookie support once migration is complete

## Troubleshooting

### Common Issues

**Legacy cookie not recognized**:

- Verify the cookie exists in the database
- Check that the conversation ID matches
- Ensure the cookie format is correct

**JWT not issued**:

- Check server logs for database query errors
- Verify the participant record exists
- Ensure the legacy cookie module is properly imported

### Debug Logging

Enable debug logging to trace legacy cookie authentication:

```javascript
logger.debug("Checking for legacy participant with permanent cookie", {
  zid,
  permanentCookie: permanentCookie.substring(0, 8) + "..." 
});
```
