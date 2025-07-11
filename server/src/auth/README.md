# Authentication Module

This module handles authentication for the Polis API server, supporting Auth0 JWT, XID JWT, and Anonymous JWT.

## Current Architecture

The authentication system uses a hybrid approach with three user types:

1. **Standard Users** - Auth0 JWT authentication
2. **XID Users** - Custom JWT for external integrations  
3. **Anonymous Users** - Custom JWT for anonymous participants

## File Structure

- `auth.ts` - Legacy authentication logic and middleware
- `hybrid-jwt.ts` - Unified authentication middleware (Auth0 + XID JWT)
- `jwt-middleware.ts` - Auth0 JWT validation
- `xid-jwt.ts` - XID JWT signing and validation
- `routes.ts` - Authentication API endpoints
- `password.ts` - Password utilities
- `create-user.ts` - User creation logic
- `index.ts` - Module exports

## Usage

### Hybrid Authentication (Recommended)

```typescript
import { createHybridJwtMiddleware } from './auth/hybrid-jwt';

// Create middleware instances
const hybridAuth = createHybridJwtMiddleware(assignToP, false);
const hybridAuthOptional = createHybridJwtMiddleware(assignToP, true);

// Required authentication
app.get('/api/v3/protected', hybridAuth, handler);

// Optional authentication
app.get('/api/v3/public', hybridAuthOptional, handler);
```

### Legacy Authentication (Deprecated -- Removed)

```typescript
import { auth, authOptional } from './auth';

// Still available for backward compatibility
app.get('/api/v3/legacy', auth(assignToP), handler);
```

## Authentication Priority

The hybrid middleware checks authentication in this order:

1. **Auth0 JWT** - Standard user authentication
2. **XID JWT** - External participant authentication
3. **Anonymous JWT** - Anonymous participant authentication

## Environment Variables

```bash
# Auth0 Configuration (for standard users)
AUTH_ISSUER=https://your-tenant.auth0.com/
AUTH_AUDIENCE=users
JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json

# In-house JWT Configuration (for XID and anonymous participants)
POLIS_JWT_ISSUER=https://pol.is/
POLIS_JWT_AUDIENCE=participants
JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem
JWT_PUBLIC_KEY_PATH=./keys/jwt-public.pem
```

## Database Requirements

Auth0 user mapping table (migration `000010_create_auth0_user_mappings.sql`):

```sql
CREATE TABLE auth0_user_mappings (
    auth0_sub VARCHAR(255) PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES users(uid),
    created BIGINT DEFAULT now_as_millis()
);
```

## Testing

```bash
# Test Auth0 JWT authentication
npm test -- __tests__/integration/auth-jwt.test.ts

# Test XID authentication
npm test -- __tests__/integration/xid-auth.test.ts

# Test route authentication
npm test -- __tests__/integration/routes-jwt-validation.test.ts
```

## Migration Status

✅ **Completed**: Auth0 JWT, XID JWT infrastructure, hybrid middleware

🚧 **In Progress**: Anonymous JWT, route validation, client updates

See the [Migration Guide](../../docs/MIGRATION_GUIDE.md) for detailed status and next steps.
