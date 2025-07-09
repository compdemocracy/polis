# JWT Deregister/Logout Migration

## Summary

Successfully migrated the Polis server's logout functionality from cookie-based sessions to JWT-only authentication.

## Changes Made

### 1. **Created JWT-only Deregister Handler**

Added `handle_POST_auth_deregister_jwt` in `src/auth/routes.ts`:

- Returns JSON response with success message
- No server-side session cleanup needed (JWTs are stateless)
- Client is responsible for removing JWT from localStorage

### 2. **Updated Route Configuration**

Modified `app.ts`:

- Removed `showPage` parameter validation (not needed for JWT)
- Uses JWT-only handler directly: `handle_POST_auth_deregister_jwt`
- No backward compatibility with cookies

### 3. **Fixed Cookie Dependencies**

Updated `src/utils/cookies.ts`:

- `getPermanentCookieAndEnsureItIsSet` handles undefined `req.cookies` gracefully
- Returns dummy token when cookies aren't available

Updated `src/auth/auth.ts`:

- Removed cookie-based authentication from auth middleware
- Removed `doCookieAuth` usage
- Added null check for `req.cookies` in legacy auth paths

### 4. **Test Updates**

Updated `__tests__/integration/auth.test.ts`:

- Tests expect JSON response from deregister endpoint
- JWT logout test verifies token remains valid after logout
- All deregister tests passing

## API Response

```json
POST /api/v3/auth/deregister

Response: 200 OK
{
  "status": "success",
  "message": "Logout successful. Please remove your JWT token."
}
```

## Client Implementation

With JWT authentication, logout is purely client-side:

```javascript
// Client-side logout
function logout() {
  // 1. Remove JWT from storage
  localStorage.removeItem('polis_jwt');
  
  // 2. Optional: Clear Auth0 session
  window.location.href = `https://${AUTH0_DOMAIN}/v2/logout?` +
    `client_id=${AUTH0_CLIENT_ID}&` +
    `returnTo=${encodeURIComponent(window.location.origin)}`;
}
```

## Benefits

1. **Stateless**: No server-side session management
2. **Scalable**: No session storage or cleanup needed
3. **Simple**: Logout is just removing the token client-side
4. **Secure**: JWTs expire automatically, no orphaned sessions

## Next Steps

1. Remove remaining cookie dependencies throughout the codebase
2. Drop `auth_tokens` table from database
3. Update client SDKs to handle JWT logout
4. Remove legacy authentication code entirely

## Migration Complete ✅

The deregister/logout endpoint now works with JWT-only authentication, removing the need for cookie-based session management.
