# Auth Test Migration Strategy

## The Problem

With Auth0 as the authentication provider, many traditional auth tests are no longer valid:

- **Registration** happens on Auth0's side, not through `/api/v3/auth/new`
- **Login** is handled by Auth0, which issues JWTs
- **Password management** is Auth0's responsibility
- **Cookie-based sessions** no longer exist

## What Tests Are Still Relevant?

### ✅ Keep These Tests

1. **JWT validation** - Server must correctly validate Auth0 JWTs
2. **Authorization** - Protected endpoints must require valid JWTs
3. **Participant authentication** - Anonymous and XID participants
4. **Logout endpoint** - Though simplified to just return success

### ❌ Remove/Deprecate These Tests

1. **Registration flow** - Auth0 handles this
2. **Login with username/password** - Auth0 handles this
3. **Cookie-based auth flow** - No longer exists
4. **Password validation** - Auth0's responsibility

## Recommended Approach

### Option 1: Disable Legacy Tests (Quick Fix)

```typescript
describe.skip('Legacy Auth Tests - Deprecated with Auth0', () => {
  // Old registration/login tests
});
```

### Option 2: Create JWT-Only Test Suite (Recommended)

Focus on what the server actually does:

- Validates JWTs from Auth0
- Issues JWTs for participants
- Enforces authorization rules

### Option 3: Mock Auth0 Endpoints (Complex)

If you need to test the full flow, mock Auth0's endpoints.
But this adds complexity for little value.

## What About `/api/v3/auth/new` and `/api/v3/auth/login`?

These endpoints still exist for backward compatibility but with Auth0:

1. **Option A**: Remove them entirely
   - Cleanest approach
   - Forces all auth through Auth0

2. **Option B**: Return helpful errors

   ```json
   {
     "error": "Please use Auth0 for authentication",
     "auth_url": "https://your-tenant.auth0.com/authorize"
   }
   ```

3. **Option C**: Keep for admin/development only
   - Restrict to specific environments
   - Not recommended for production

## Testing Strategy Going Forward

### Unit Tests

- JWT validation logic
- Authorization middleware
- Participant JWT issuance

### Integration Tests

- Protected endpoint access
- JWT token handling
- Participant flows

### E2E Tests (External)

- Full Auth0 login flow
- Token refresh
- Logout flow

## Conclusion

The failing tests are a sign that the authentication architecture has fundamentally changed. Rather than trying to make old tests pass, embrace the new JWT-only architecture with appropriate tests that reflect how authentication actually works now.
