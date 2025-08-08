# Polis Authentication System

## Overview

Polis uses a hybrid JWT-based authentication system supporting multiple user types and authentication pathways. The system maintains backward compatibility with legacy cookie-based authentication while providing modern JWT tokens for all participant types.

## Core Concepts

### Users vs Participants

- **Users** (`users` table): Global accounts with unique UIDs. Can be anonymous or authenticated via OIDC.
- **Participants** (`participants` table): Conversation-specific records linking users to conversations. Each user can be a participant in multiple conversations with different PIDs.
- **Relationship**: A user (uid) becomes a participant (pid) when they join a conversation (zid).

### User Types

1. **Standard Users**
   - Authenticated via OIDC (Auth0, etc.)
   - Can create and manage conversations
   - Receive conversation-scoped JWTs when participating
   - Mapped via `oidc_user_mappings` table

2. **XID Participants**
   - External ID users from third-party integrations
   - Conversation-scoped identity (XID valid only within specific conversation)
   - Receive custom JWT tokens
   - Can participate but not create conversations

3. **Anonymous Participants**
   - No authentication required
   - Receive JWT tokens on first action (vote/comment)
   - Can participate but not create conversations

## Authentication Flow

### Token Priority

The hybrid authentication middleware (`hybrid-jwt.ts`) checks tokens in this order:

1. **XID JWT** - External participant tokens
2. **Anonymous JWT** - Anonymous participant tokens  
3. **Standard User JWT** - OIDC user participant tokens
4. **OIDC JWT** - Direct OIDC tokens for admin operations
5. **Legacy Cookie** - Permanent cookie (`pc`) for backward compatibility

### Participant Creation & JWT Issuance

#### 1. ParticipationInit (`GET /api/v3/participationInit`)

**Does NOT create participants** - only recognizes existing ones:

- Returns existing participant data if found
- Issues JWT only for existing participants (all types)
- New anonymous participants receive no JWT (will get one on first action)

#### 2. First Vote (`POST /api/v3/votes`)

Creates participants and issues JWTs:

1. Check for existing user/participant
2. If new:
   - Create anonymous user (if no uid)
   - Create participant record
   - Issue appropriate JWT (Anonymous/XID/Standard User)
3. If existing but no JWT:
   - Issue appropriate JWT

#### 3. First Comment (`POST /api/v3/comments`)

Similar to voting:

1. Check for existing user/participant
2. If new:
   - Create anonymous user (if no uid)
   - Create participant record  
   - Issue appropriate JWT
3. Process comment with moderation

### JWT Token Structure

#### Anonymous JWT

```json
{
  "sub": "anon:<uid>",
  "uid": 123,
  "pid": 456,
  "conversation_id": "abc123",
  "anonymous_participant": true,
  "exp": 1234567890
}
```

#### XID JWT

```json
{
  "sub": "xid:<external_id>",
  "xid": "external-user-123",
  "uid": 123,
  "pid": 456,
  "conversation_id": "abc123",
  "xid_participant": true,
  "exp": 1234567890
}
```

#### Standard User JWT

```json
{
  "sub": "user:<oidc_sub>",
  "oidc_sub": "auth0|507f1f77bcf86cd799439011",
  "uid": 123,
  "pid": 456,
  "conversation_id": "abc123",
  "standard_user_participant": true,
  "exp": 1234567890
}
```

## Conversation Scoping

### XID Participants

XIDs are strictly conversation-scoped. The same external ID in different conversations:

- Gets different UIDs
- Gets different PIDs
- Cannot cross-authenticate between conversations

When an XID participant presents a JWT for a different conversation:

1. **Case 1**: Valid setup - Token matches conversation, XID matches token
2. **Case 2**: Token/XID match but wrong conversation → Treated as anonymous
3. **Case 3**: Token wrong conversation, XID for current → Use XID for current
4. **Case 4**: Token for current, XID for different → Treated as anonymous

### Anonymous Participants

Anonymous JWTs are conversation-scoped. A JWT for one conversation cannot be used in another - the participant will be treated as new.

### Standard Users

Standard users maintain their identity across conversations but receive conversation-specific participant JWTs. The OIDC identity links all their participations.

## Legacy Cookie Support

The system maintains backward compatibility with permanent cookies (`pc`):

1. **Detection**: Checks for `pc` cookie in requests
2. **Lookup**: Finds existing participant via `participants_extended.permanent_cookie`
3. **JWT Issuance**: Issues appropriate JWT for the existing participant
4. **Migration**: One-way migration - participants should use JWT going forward

This is a transitional feature that will be removed once migration is complete.

## Implementation

### Key Files

- `src/auth/hybrid-jwt.ts` - Unified authentication middleware
- `src/auth/jwt-utils.ts` - Core JWT utilities and types
- `src/auth/anonymous-jwt.ts` - Anonymous participant JWT handling
- `src/auth/xid-jwt.ts` - XID participant JWT handling
- `src/auth/standard-user-jwt.ts` - Standard user participant JWT handling
- `src/auth/legacyCookies.ts` - Legacy cookie compatibility
- `src/auth/create-user.ts` - User creation logic

### Environment Configuration

```bash
# OIDC Configuration (for standard users)
AUTH_ISSUER=https://your-tenant.auth0.com/
AUTH_AUDIENCE=users
JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json

# In-house JWT Configuration (for participants)
POLIS_JWT_ISSUER=https://pol.is/
POLIS_JWT_AUDIENCE=participants
JWT_PRIVATE_KEY=[base64 encoded private key]
JWT_PUBLIC_KEY=[base64 encoded public key]
```

### Middleware Usage

```typescript
import { hybridAuth, hybridAuthOptional } from './auth/hybrid-jwt';

// Required authentication
app.get('/api/v3/protected', hybridAuth(assignToP), handler);

// Optional authentication  
app.get('/api/v3/public', hybridAuthOptional(assignToP), handler);
```

## Security Considerations

### Token Security

- RSA-256 signing with 2048-bit keys
- 1-year expiration (no refresh mechanism)
- Conversation-scoped to prevent cross-conversation usage
- No sensitive data in JWT claims

### Domain Whitelisting

- Conversations can restrict participation by domain
- Checked via `site_domain_whitelist` table
- Empty whitelist allows all domains

### XID Whitelisting

- Conversations can restrict XIDs via `xid_whitelist`
- Only whitelisted XIDs can participate when enabled

## Testing

```bash
# Integration tests
npm test -- __tests__/integration/auth-jwt.test.ts
npm test -- __tests__/integration/xid-auth.test.ts
npm test -- __tests__/integration/anonymous-jwt.test.ts
npm test -- __tests__/integration/legacy-cookie.test.ts

# Unit tests
npm test -- __tests__/unit/xid-jwt.test.ts
npm test -- __tests__/unit/standard-user-jwt.test.ts
```

## Migration Status

✅ **Completed**

- JWT infrastructure for all participant types
- Hybrid authentication middleware
- Legacy cookie support
- Route validation
- Client SDK updates

## Client Integration

### Storing Tokens

```javascript
// After participation/vote/comment
if (response.auth && response.auth.token) {
  localStorage.setItem('polis_jwt', response.auth.token);
}
```

### Using Tokens

```javascript
const token = localStorage.getItem('polis_jwt');
fetch('/api/v3/votes', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  // ...
});
```

### Handling Conversation Changes

When switching conversations, clients should:

1. Keep existing conversation-scoped tokens
2. Call participationInit for the new conversation
3. Store any new tokens received
