# Authentication Module

This module handles authentication for the Polis API server, supporting OIDC JWT, XID JWT, and Anonymous JWT.

## Current Architecture

The authentication system uses a hybrid approach with three user types:

1. **Standard Users** - OIDC JWT authentication
2. **XID Users** - Custom JWT for external integrations  
3. **Anonymous Users** - Custom JWT for anonymous participants

## File Structure

- `auth.ts` - Legacy authentication logic and middleware
- `hybrid-jwt.ts` - Unified authentication middleware (OIDC + XID JWT)
- `jwt-middleware.ts` - OIDC JWT validation
- `xid-jwt.ts` - XID JWT signing and validation
- `anonymous-jwt.ts` - Anonymous participant JWT signing and validation
- `legacyCookies.ts` - Legacy permanent cookie support for backward compatibility
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

1. **OIDC JWT** - Standard user authentication
2. **XID JWT** - External participant authentication
3. **Anonymous JWT** - Anonymous participant authentication
4. **Legacy Cookie** - Permanent cookie (`pc`) lookup for existing participants (transitional)

## Environment Variables

```bash
# OIDC Configuration (for standard users)
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

OIDC user mapping table (migration `000010_create_oidc_user_mappings.sql`):

```sql
CREATE TABLE oidc_user_mappings (
    oidc_sub VARCHAR(255) PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES users(uid),
    created BIGINT DEFAULT now_as_millis()
);
```

## Testing

```bash
# Test OIDC JWT authentication
npm test -- __tests__/integration/auth-jwt.test.ts

# Test XID authentication
npm test -- __tests__/integration/xid-auth.test.ts

# Test route authentication
npm test -- __tests__/integration/routes-jwt-validation.test.ts
```

## Migration Status

✅ **Completed**: OIDC JWT, XID JWT infrastructure, hybrid middleware, Anonymous JWT, legacy cookie support

🚧 **In Progress**: Route validation, client updates

See the [Migration Guide](../../docs/MIGRATION_GUIDE.md) for detailed status and next steps.
