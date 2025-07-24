# Standard User JWT Authentication

This document describes the JWT authentication implementation for standard users (OIDC-authenticated) when they participate in Polis conversations.

## Overview

Standard users who authenticate via OIDC now receive conversation-scoped JWT tokens when they participate in conversations, providing consistency with XID and anonymous participants while maintaining their authenticated identity.

## Why This Approach?

Previously, when a standard user with an OIDC token participated in a conversation, the system would:

1. Treat them as a new anonymous participant
2. Create a new user record with a new uid
3. Issue an anonymous JWT

This was problematic because:

- It created duplicate user records
- Lost the connection to the user's authenticated identity
- Prevented proper tracking of user participation across sessions

## Solution

The new approach:

1. Recognizes OIDC tokens in participant requests
2. Uses the existing uid from `oidc_user_mappings` table
3. Issues a conversation-scoped "Standard User JWT" that maintains the OIDC identity link

## JWT Structure

Standard User JWTs contain the following claims:

```typescript
interface StandardUserJwtClaims {
  aud: string;                       // Audience (Config.polisJwtAudience)
  exp: number;                       // Expiration time (1 year)
  iat: number;                       // Issued at time
  iss: string;                       // Issuer (Config.polisJwtIssuer)
  pid: number;                       // Participant ID
  sub: string;                       // Subject format: "user:<oidc_sub>"
  uid: number;                       // Local user ID
  oidc_sub: string;                 // OIDC subject identifier
  conversation_id: string;           // Conversation this token is valid for
  standard_user_participant: boolean; // Flag to identify standard user JWTs
}
```

## Authentication Flow

1. **Initial OIDC Login**:
   - User logs in via OIDC
   - Receives OIDC JWT with their oidc_sub
   - Server maps oidc_sub to local uid via `oidc_user_mappings`

2. **Conversation Participation**:

   ```txt
   GET /api/v3/participationInit?conversation_id=abc
   Authorization: Bearer <oidc_jwt>
   ```

   - Server recognizes OIDC JWT
   - Looks up uid from oidc_user_mappings
   - Creates/finds participant record
   - Issues Standard User JWT

3. **Subsequent Requests**:

   ```txt
   POST /api/v3/votes
   Authorization: Bearer <standard_user_jwt>
   ```

   - Uses conversation-scoped Standard User JWT
   - Maintains link to OIDC identity

## Implementation Details

### Key Files

- `src/auth/standard-user-jwt.ts` - Core JWT functions
- `src/auth/hybrid-jwt.ts` - Updated hybrid auth middleware
- `src/routes/votes.ts` - Updated vote handling
- `src/routes/participation.ts` - Updated participation handling

### Token Issuance

Standard User JWTs are issued in two scenarios:

1. **During participation initialization** (`/api/v3/participationInit`)
   - When a standard user with OIDC token joins a conversation
   - Only if they already have a participant record

2. **On first vote** (`/api/v3/votes`)
   - When a standard user votes for the first time
   - Creates participant record and issues JWT

### Hybrid Authentication Order

The hybrid authentication middleware checks tokens in this order:

1. **XID JWT** - External participant tokens
2. **Anonymous JWT** - Anonymous participant tokens
3. **Standard User JWT** - OIDC user participant tokens
4. **OIDC JWT** - Direct OIDC tokens

## Benefits

1. **User Continuity**: Maintains connection to authenticated identity
2. **Conversation Scoping**: Same security model as other participant types
3. **No Duplicate Records**: Uses existing uid from oidc_user_mappings
4. **Consistent Architecture**: All participant types use conversation-scoped JWTs

## Migration Considerations

### Backward Compatibility

- Existing OIDC tokens continue to work
- Standard users can still use OIDC tokens directly
- Gradual migration as users participate in conversations

### Client Updates

Clients should be updated to:

1. Store returned Standard User JWTs
2. Use them for subsequent conversation-specific requests
3. Fall back to OIDC tokens for non-conversation APIs

## Security Considerations

- Uses same RSA-256 encryption as XID/Anonymous JWTs
- 1-year expiration (no refresh mechanism)
- Conversation-scoped to prevent cross-conversation usage
- Maintains audit trail via oidc_sub link

## Future Enhancements

1. **Token Refresh**: Consider adding refresh mechanism for long sessions
2. **XID Integration**: Handle standard users who also have XIDs
3. **Session Management**: Improve handling of multiple active conversations
