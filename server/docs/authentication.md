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
   - Owner-scoped identity (the same XID identifies the same user across that owner's conversations)
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

**Recognizes existing participants and creates XID participants on first visit**:

- Returns existing participant data if found
- Issues JWTs for existing participants and newly created XID participants
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

XIDs are scoped to the conversation owner. The same external ID in different conversations:

- Resolves to the same UID when the conversations have the same owner
- Has a separate participant record (PID) in each conversation
- Resolves independently when the conversations have different owners

An XID is an identifier, not a credential that proves who is presenting it. Within an owner's conversations, anyone presenting the same XID can act as that participant.

The embedding site must issue each user's XID from its own authenticated session. Use an unguessable value, such as a per-user random token or an HMAC of the site's user ID computed with a secret key held by the site, and never share an XID across users. Keep the same XID for a user on every visit: store and reuse a random token, or keep the HMAC key stable. A new XID creates a new user and participant. Do not use a public username, email address or sequential user ID directly.

A site that keeps XIDs private from other participants gets per-user identity against those participants; a site that cannot should expect anyone holding an XID to act as that participant. This includes voting, submitting comments, obtaining the participant's token through participationInit, and reading the profile fields the site attached to the XID through GET /users. The conversation owner, moderators on the owner's site and Polis admins can see a conversation's XIDs through GET /xids and the XID export. Per-user identity does not isolate participants from those accounts.

The embed places the XID in the iframe URL, so serve the embedding page only to that signed-in user. Keep XIDs out of shared links and treat tokens containing them as sensitive.

When an XID participant presents a JWT:

1. **Case 1**: Token matches conversation, XID matches token → Use the token's participant identity
2. **Case 2**: Token/XID match but wrong conversation → Resolve the XID under the requested conversation's owner
3. **Case 3**: Token for another conversation, request supplies an XID → Resolve the supplied XID under the requested conversation's owner
4. **Case 4**: Token for requested conversation, request supplies a different XID → Resolve the supplied XID under the requested conversation's owner

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
- Participant JWTs carry a conversation ID; for XID participants, a token for another conversation supplies no participant identity. The request's XID, or the token's XID if the request names none, is resolved under the requested conversation's owner
- XID JWT claims contain the XID; keep these tokens private

### Domain Whitelisting

- Conversations can restrict participation by domain
- Checked via `site_domain_whitelist` table
- Empty whitelist allows all domains

### XID Whitelisting

- Conversations opt in with `use_xid_whitelist` to their owner's XID allow-list (the `xid_whitelist` table)
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
