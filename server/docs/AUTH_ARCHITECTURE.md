# Authentication Architecture

## Overview

Polis uses a hybrid authentication system supporting three user types:

1. **Standard Users** - Auth0 JWT authentication (email/password, social login) - can create/manage conversations
2. **XID Participants** - External ID users with custom JWT tokens - participate only
3. **Anonymous Participants** - Custom JWT tokens issued by server - participate only

## Architecture Diagram

```txt
Standard Users:       Browser → Auth0 → Auth0 JWT → API validates with JWKS
XID Participants:     Browser → participationInit?xid=X → Custom JWT → API validates locally  
Anonymous Participants: Browser → participationInit → Custom JWT → API validates locally
```

## Implementation

### Hybrid Authentication Middleware

The system uses a unified middleware (`hybrid-jwt.ts`) that checks authentication in priority order:

1. Auth0 JWT tokens (for standard users)
2. XID JWT tokens (for external participants)
3. Anonymous JWT tokens (for anonymous participants)

```typescript
// Usage in routes
app.get('/api/v3/protected', hybridAuth(assignToP), handler);
app.get('/api/v3/public', hybridAuthOptional(assignToP), handler);
```

### JWT Token Structure

**Auth0 JWT (Standard Users)**

```json
{
  "iss": "https://your-tenant.auth0.com/",
  "sub": "auth0|507f1f77bcf86cd799439011",
  "aud": "your-api-audience",
  "email": "user@example.com"
}
```

**XID JWT (External Participants)**

```json
{
  "iss": "https://your-polis-server/",
  "sub": "xid:external-user-123",
  "xid": "external-user-123",
  "conversation_id": "abc123",
  "uid": 456,
  "pid": 789,
  "anonymous": true,
  "xid_participant": true
}
```

## Security Features

### XID Conversation Scoping

- XID identity is tied to a specific conversation
- XID users can participate in other conversations as anonymous users
- XID tokens cannot be used across different conversations

### Token Security

- RSA-256 signing with 2048-bit keys
- 24-hour expiration (no refresh)
- Strict audience and issuer validation
- No sensitive data in JWT claims

## Environment Configuration

```bash
# Auth0 Configuration
AUTH_ISSUER=https://your-tenant.auth0.com/
AUTH_AUDIENCE=your-api-audience
AUTH_CLIENT_ID=your-client-id
JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json

# XID JWT Configuration
AUTH_CERTS_PATH=~/.simulacrum/certs
AUTH_KEYS_PATH=./keys
```

## Current Status

✅ **Implemented**

- Auth0 JWT authentication for standard users
- XID JWT infrastructure and validation
- Hybrid authentication middleware
- Database migration for Auth0 user mapping
- Test infrastructure with Auth0 simulator

🚧 **In Progress**

- Anonymous user JWT tokens
- Full route validation with JWT
- Client SDK updates for localStorage

## Testing

The system includes comprehensive test coverage:

- `auth-jwt.test.ts` - Auth0 JWT authentication
- `xid-auth.test.ts` - XID participant flows
- `anonymous-jwt.test.ts` - Anonymous participant flows
- `routes-jwt-validation.test.ts` - Route-by-route validation

See the [Migration Guide](./MIGRATION_GUIDE.md) for implementation details and next steps.
