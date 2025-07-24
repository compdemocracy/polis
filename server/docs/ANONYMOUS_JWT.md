# Anonymous JWT Authentication

This document describes the JWT authentication implementation for anonymous participants (those without XIDs) in Polis.

## Overview

Anonymous participants now receive JWT tokens similar to XID participants, providing a consistent authentication mechanism across all participant types while maintaining backward compatibility.

## Key Features

- **JWT-based auth**: Anonymous participants receive JWT tokens instead of relying on cookies
- **Conversation-scoped**: Tokens are scoped to specific conversations, maintaining privacy
- **1-year expiration**: Tokens expire after 1 year, allowing participants to be recognized for extended periods

## Implementation Details

### JWT Structure

Anonymous JWTs contain the following claims:

```typescript
interface AnonymousJwtClaims {
  aud: string;              // Audience (from Config.authAudience)
  exp: number;              // Expiration time (1 year from issuance)
  iat: number;              // Issued at time
  iss: string;              // Issuer (from Config.authIssuer)
  pid: number;              // Participant ID
  sub: string;              // Subject format: "anon:<uid>"
  uid: number;              // Local user ID
  conversation_id: string;  // The conversation this token is valid for
  anonymous_participant: boolean; // Flag to identify anonymous JWTs
}
```

### Token Issuance

Anonymous JWTs are issued in two scenarios:

1. **During participation initialization** (`/api/v3/participationInit`)
   - If the participant already exists (has uid and pid)
   - Token is included in the response's `auth` field

2. **On first vote** (`/api/v3/votes`)
   - When an anonymous user votes for the first time
   - Creates the participant record and issues JWT
   - Token is included in the vote response's `auth` field

### Token Usage

Anonymous JWTs can be used by including them in the Authorization header:

```txt
Authorization: Bearer <jwt_token>
```

The hybrid authentication middleware automatically detects and validates anonymous JWTs.

### Security Considerations

- Uses RSA-256 encryption with 2048-bit keys (same as XID JWTs)
- Tokens are conversation-scoped - cannot be used across conversations
- No refresh mechanism - participants must re-initialize after expiration
- Subject format (`anon:<uid>`) clearly distinguishes from other token types

## API Changes

### Response Format

Endpoints that issue JWTs include an `auth` object in the response:

```json
{
  "auth": {
    "token": "eyJhbGc...",
    "token_type": "Bearer",
    "expires_in": 86400
  },
  // ... other response data
}
```

### Affected Endpoints

- `GET /api/v3/participationInit` - Issues JWT for existing anonymous participants
- `POST /api/v3/votes` - Issues JWT on first vote for new anonymous participants

## Testing

See `server/__tests__/integration/anonymous-jwt.test.ts` for comprehensive tests covering:

- JWT issuance on participation
- JWT issuance on first vote
- Using JWT for authenticated requests
- Conversation scoping
- Integration with hybrid auth middleware

## Future Considerations

1. **Token refresh**: Currently not implemented, but could be added if needed
2. **Migration completion**: Once stable, cookie-based auth for anonymous users can be deprecated
3. **Analytics**: Track JWT vs cookie usage to monitor migration progress
