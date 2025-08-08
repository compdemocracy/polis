# Authentication Module

This module implements JWT-based authentication for the Polis API server.

## Quick Reference

### File Structure

- `hybrid-jwt.ts` - Unified authentication middleware
- `jwt-utils.ts` - Core JWT utilities and types
- `jwt-middleware.ts` - OIDC JWT validation
- `anonymous-jwt.ts` - Anonymous participant JWT
- `xid-jwt.ts` - XID participant JWT  
- `standard-user-jwt.ts` - Standard user participant JWT
- `legacyCookies.ts` - Legacy cookie support
- `create-user.ts` - User creation logic
- `routes.ts` - Authentication endpoints
- `index.ts` - Module exports

### Usage

```typescript
import { hybridAuth, hybridAuthOptional } from './auth/hybrid-jwt';

// Required authentication
app.get('/api/v3/protected', hybridAuth(assignToP), handler);

// Optional authentication
app.get('/api/v3/public', hybridAuthOptional(assignToP), handler);
```

### Authentication Priority

1. XID JWT - External participant tokens
2. Anonymous JWT - Anonymous participant tokens
3. Standard User JWT - OIDC user participant tokens  
4. OIDC JWT - Direct OIDC tokens
5. Legacy Cookie - Backward compatibility

## Full Documentation

For complete authentication documentation including flows, token structures, and client integration, see:

📖 **[/docs/AUTHENTICATION.md](../../docs/AUTHENTICATION.md)**

## Testing

```bash
# Run all auth tests
npm test -- __tests__/integration/auth
npm test -- __tests__/unit/*jwt*

# Specific test files
npm test -- __tests__/integration/auth-jwt.test.ts
npm test -- __tests__/integration/xid-auth.test.ts
npm test -- __tests__/integration/anonymous-jwt.test.ts
```