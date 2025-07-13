# Standard User JWT Authentication

This document describes the JWT authentication implementation for standard users (Auth0-authenticated) when they participate in Polis conversations.

## Overview

Standard users who authenticate via Auth0 now receive conversation-scoped JWT tokens when they participate in conversations, providing consistency with XID and anonymous participants while maintaining their authenticated identity.

## Why This Approach?

Previously, when a standard user with an Auth0 token participated in a conversation, the system would:

1. Treat them as a new anonymous participant
2. Create a new user record with a new uid
3. Issue an anonymous JWT

This was problematic because:

- It created duplicate user records
- Lost the connection to the user's authenticated identity
- Prevented proper tracking of user participation across sessions

## Solution

The new approach:

1. Recognizes Auth0 tokens in participant requests
2. Uses the existing uid from `auth0_user_mappings` table
3. Issues a conversation-scoped "Standard User JWT" that maintains the Auth0 identity link

## JWT Structure

Standard User JWTs contain the following claims:

```typescript
interface StandardUserJwtClaims {
  aud: string;                       // Audience (Config.polisJwtAudience)
  exp: number;                       // Expiration time (24 hours)
  iat: number;                       // Issued at time
  iss: string;                       // Issuer (Config.polisJwtIssuer)
  pid: number;                       // Participant ID
  sub: string;                       // Subject format: "user:<auth0_sub>"
  uid: number;                       // Local user ID
  auth0_sub: string;                 // Auth0 subject identifier
  conversation_id: string;           // Conversation this token is valid for
  standard_user_participant: boolean; // Flag to identify standard user JWTs
}
```

## Authentication Flow

1. **Initial Auth0 Login**:
   - User logs in via Auth0
   - Receives Auth0 JWT with their auth0_sub
   - Server maps auth0_sub to local uid via `auth0_user_mappings`

2. **Conversation Participation**:

   ```txt
   GET /api/v3/participationInit?conversation_id=abc
   Authorization: Bearer <auth0_jwt>
   ```

   - Server recognizes Auth0 JWT
   - Looks up uid from auth0_user_mappings
   - Creates/finds participant record
   - Issues Standard User JWT

3. **Subsequent Requests**:

   ```txt
   POST /api/v3/votes
   Authorization: Bearer <standard_user_jwt>
   ```

   - Uses conversation-scoped Standard User JWT
   - Maintains link to Auth0 identity

## Implementation Details

### Key Files

- `src/auth/standard-user-jwt.ts` - Core JWT functions
- `src/auth/hybrid-jwt.ts` - Updated hybrid auth middleware
- `src/routes/votes.ts` - Updated vote handling
- `src/routes/participation.ts` - Updated participation handling

### Token Issuance

Standard User JWTs are issued in two scenarios:

1. **During participation initialization** (`/api/v3/participationInit`)
   - When a standard user with Auth0 token joins a conversation
   - Only if they already have a participant record

2. **On first vote** (`/api/v3/votes`)
   - When a standard user votes for the first time
   - Creates participant record and issues JWT

### Hybrid Authentication Order

The hybrid authentication middleware checks tokens in this order:

1. **XID JWT** - External participant tokens
2. **Anonymous JWT** - Anonymous participant tokens
3. **Standard User JWT** - Auth0 user participant tokens
4. **Auth0 JWT** - Direct Auth0 tokens

## Benefits

1. **User Continuity**: Maintains connection to authenticated identity
2. **Conversation Scoping**: Same security model as other participant types
3. **No Duplicate Records**: Uses existing uid from auth0_user_mappings
4. **Consistent Architecture**: All participant types use conversation-scoped JWTs

## Migration Considerations

### Backward Compatibility

- Existing Auth0 tokens continue to work
- Standard users can still use Auth0 tokens directly
- Gradual migration as users participate in conversations

### Client Updates

Clients should be updated to:

1. Store returned Standard User JWTs
2. Use them for subsequent conversation-specific requests
3. Fall back to Auth0 tokens for non-conversation APIs

## Security Considerations

- Uses same RSA-256 encryption as XID/Anonymous JWTs
- 24-hour expiration (no refresh mechanism)
- Conversation-scoped to prevent cross-conversation usage
- Maintains audit trail via auth0_sub link

## Future Enhancements

1. **Token Refresh**: Consider adding refresh mechanism for long sessions
2. **XID Integration**: Handle standard users who also have XIDs
3. **Session Management**: Improve handling of multiple active conversations
