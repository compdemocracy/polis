# XID JWT Authentication

## Overview

XID (External ID) authentication allows third-party integrations to authenticate participants without cookies, using JWT tokens stored in localStorage. This enables Polis to work in third-party contexts where cookies are blocked.

## Current Status ✅

The XID JWT infrastructure is **fully implemented** and tested:

- ✅ JWT signing and verification system (`src/auth/xid-jwt.ts`)
- ✅ Hybrid authentication middleware (`src/auth/hybrid-jwt.ts`)
- ✅ ParticipationInit JWT support
- ✅ RSA key generation tooling
- ✅ Comprehensive test coverage

## How It Works

### Authentication Flow

1. **Initial Request** (No existing user):

   ```txt
   GET /api/v3/participationInit?conversation_id=abc&xid=user123
   ```

   - Creates new user record via XID authentication
   - Returns conversation data (JWT issued on subsequent requests)

2. **Subsequent Requests** (User exists):

   ```txt
   GET /api/v3/participationInit?conversation_id=abc&xid=user123
   ```

   Response includes JWT:

   ```json
   {
     "conversation": { ... },
     "nextComment": { ... },
     "auth": {
       "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...",
       "token_type": "Bearer",
       "expires_in": 86400
     }
   }
   ```

3. **Using JWT for API Calls**:

   ```txt
   POST /api/v3/votes
   Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...
   ```

### JWT Token Structure

```json
{
  "aud": "users",
  "iss": "https://localhost:3000/",
  "sub": "xid:external-user-123",
  "xid": "external-user-123",
  "uid": 123,
  "pid": "participant-id",
  "conversation_id": "abc123",
  "anonymous": true,
  "xid_participant": true,
  "exp": 1735776661,
  "iat": 1735690261
}
```

## Implementation

### Key Files

- `src/auth/xid-jwt.ts` - Core JWT functions
- `src/auth/hybrid-jwt.ts` - Hybrid auth middleware
- `src/routes/participation.ts` - Updated participationInit
- `scripts/generate-jwt-keys.js` - Key generation

### Server-Side Usage

```typescript
import { issueXidJWT } from '../auth/xid-jwt';

// Issue JWT for XID participant
const token = issueXidJWT(
  'user123',           // External ID
  'conversation456',   // Conversation ID  
  789,                 // Local user ID
  'pid012'            // Participant ID
);

// Protect routes with hybrid auth
app.post('/api/v3/votes', 
  hybridAuthOptional(assignToP),  // Supports both OIDC and XID JWT
  handleVote
);
```

### Client-Side Integration

```javascript
// Initial participation
const response = await fetch('/api/v3/participationInit?conversation_id=abc&xid=user123');
const data = await response.json();

// Store JWT if provided
if (data.auth && data.auth.token) {
  localStorage.setItem('polis_xid_token', data.auth.token);
}

// Use JWT in subsequent requests
const token = localStorage.getItem('polis_xid_token');
const voteResponse = await fetch('/api/v3/votes', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    tid: 1,
    vote: 1,
    conversation_id: 'abc'
  })
});
```

## Setup Instructions

### 1. Generate RSA Keys

```bash
# Generate keys for development
node scripts/generate-jwt-keys.js
```

This creates:

- `keys/jwt-private.pem` - Private key for signing
- `keys/jwt-public.pem` - Public key for verification

### 2. Configure Environment

**Development (.env):**

```bash
AUTH_CERTS_PATH=~/.simulacrum/certs
AUTH_KEYS_PATH=./keys
```

**Production (Environment Variables):**

```bash
# Base64 encoded keys for containers
JWT_PRIVATE_KEY=LS0tLS1CRUdJTi...
JWT_PUBLIC_KEY=LS0tLS1CRUdJTi...
```

## Security Considerations

### Conversation Scoping

- XID JWTs are scoped to specific conversations
- Cannot be used across different conversations
- XID users can participate in other conversations as anonymous users

### Token Security

- RSA-256 signing algorithm
- 2048-bit key length
- 1-year expiration (no refresh)
- No sensitive data in claims

## Testing

```bash
# Run unit tests
npm test -- __tests__/unit/xid-jwt.test.ts

# Run integration tests  
npm test -- __tests__/integration/xid-auth.test.ts
npm test -- __tests__/integration/anonymous-jwt.test.ts
```

## Migration Notes

### Backward Compatibility

The system maintains full backward compatibility:

- Cookie-based XID auth continues to work
- New XID participants get JWT tokens
- Existing integrations don't need immediate updates

### Benefits

- **No cookies required** - Works in third-party contexts
- **Stateless** - No server-side session management
- **Standard format** - Industry-standard JWT
- **OIDC compatible** - Coexists with OIDC authentication
