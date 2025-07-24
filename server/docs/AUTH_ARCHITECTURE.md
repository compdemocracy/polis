# Authentication Architecture

## Overview

Polis uses a hybrid authentication system supporting three user types:

1. **Standard Users** - OIDC JWT authentication (email/password, social login) - can create/manage conversations
2. **XID Participants** - External ID users with custom JWT tokens - participate only
3. **Anonymous Participants** - Custom JWT tokens issued by server - participate only

## Architecture Diagram

```txt
Standard Users:       Browser → OIDC → OIDC JWT → API validates with JWKS
XID Participants:     Browser → participationInit?xid=X → Custom JWT → API validates locally  
Anonymous Participants: Browser → participationInit → Custom JWT → API validates locally
```

## Implementation

### Hybrid Authentication Middleware

The system uses a unified middleware (`hybrid-jwt.ts`) that checks authentication in priority order:

1. OIDC JWT tokens (for standard users, issued by OIDC)
2. XID JWT tokens (for external participants)
3. Anonymous JWT tokens (for anonymous participants)
4. User JWT tokens (for standard users, issued by Polis)

```typescript
// Usage in routes
app.get('/api/v3/protected', hybridAuth(assignToP), handler);
app.get('/api/v3/public', hybridAuthOptional(assignToP), handler);
```

### Parameter Middleware System

The authentication system integrates with Polis's parameter middleware system through the `assignToP` function. This ensures:

- **Consistent parameter handling**: All route parameters follow the same validation pattern
- **Clobbering detection**: Prevents accidental overwrites of existing parameters
- **Error handling**: Standardized error responses for parameter validation

JWT extraction functions use the assigner function (typically `assignToP`) rather than direct assignment to maintain compatibility with the existing parameter middleware architecture.

### JWT Token Structure

**OIDC JWT (Standard Users)**

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
  "iss": "https://pol.is/",
  "sub": "xid:external-user-123",
  "xid": "external-user-123",
  "conversation_id": "abc123",
  "uid": 456,
  "pid": 789,
  "anonymous": true,
  "xid_participant": true
}
```

**Anonymous JWT (Anonymous Participants)**

```json
{
  "iss": "https://pol.is/",
  "sub": "anon:456",
  "uid": 456,
  "pid": 789,
  "conversation_id": "abc123",
  "anonymous": true,
  "anonymous_participant": true
}
```

**User JWT (Standard Users)**

```json
{
  "iss": "https://pol.is/",
  "sub": "user:auth0|507f1f77bcf86cd799439011",
  "aud": "users",
  "exp": 1715769600,
  "iat": 1715766000,
  "pid": 123,
  "uid": 456,
  "oidc_sub": "auth0|507f1f77bcf86cd799439011",
  "conversation_id": "abc123",
  "standard_user_participant": true
}
```

## Security Features

### XID Conversation Scoping

- XID identity is tied to a specific conversation
- XID users can participate in other conversations as anonymous users
- XID tokens cannot be used across different conversations

### Token Security

- RSA-256 signing with 2048-bit keys
- 1-year expiration (no refresh)
- Strict audience and issuer validation
- No sensitive data in JWT claims

### Legacy Cookie Support

The system maintains backward compatibility with legacy permanent cookies (`pc` cookie) for existing participants:

- **Automatic JWT Issuance**: When a request contains a valid permanent cookie, the system looks up the existing participant and issues a new JWT
- **Seamless Migration**: Participants with legacy cookies receive JWTs automatically, allowing them to transition to the new authentication system
- **All Endpoints Supported**: Works with `/api/v3/votes`, `/api/v3/comments`, and `/api/v3/participationInit`
- **Preserves Identity**: Maintains the same participant ID (pid) and user ID (uid) from the legacy system

See [LEGACY_COOKIE.md](./LEGACY_COOKIE.md) for implementation details.

## Environment Configuration

```bash
# OIDC Configuration (for standard users)
AUTH_ISSUER=https://your-tenant.auth0.com/
AUTH_AUDIENCE=users
AUTH_CERTS_PATH=~/.simulacrum/certs
AUTH_CLIENT_ID=your-client-id
JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json

# In-house JWT Configuration (for XID and anonymous participants)
POLIS_JWT_ISSUER=https://pol.is/
POLIS_JWT_AUDIENCE=participants
JWT_PRIVATE_KEY=[base64 encoded private key]
JWT_PUBLIC_KEY=[base64 encoded public key]
```

## Current Status

✅ **Implemented**

- OIDC JWT authentication for standard users
- XID JWT infrastructure and validation
- Hybrid authentication middleware
- Database migration for OIDC user mapping
- Test infrastructure with OIDC simulator
- Anonymous user JWT tokens
- Full route validation with JWT
- Client SDK updates for localStorage
- User JWT tokens for standard users
