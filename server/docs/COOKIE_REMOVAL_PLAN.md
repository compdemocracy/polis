# Cookie Removal Plan

## Overview

This document outlines the plan to remove all cookie dependencies from the Polis server as part of the Auth0 JWT migration.

**CURRENT STATUS**: ✅ **100% COMPLETE!** All cookies have been successfully removed from the Polis server!

## Current Cookie Usage

### Authentication Cookies ✅ REMOVED

- **TOKEN** (`token2`) - Session token stored in cookies
- **UID** (`uid2`) - User ID for client-side reference
- **Status**: ✅ COMPLETELY REMOVED - replaced by JWT authentication
- **hasAuthToken** function removed
- **handle_POST_auth_login** removed
- **handle_POST_auth_new** removed

### User Information Cookies ✅ REMOVED

- **HAS_EMAIL** (`e`) - Indicates if user has email
- **USER_CREATED_TIMESTAMP** (`uc`) - User creation timestamp
- **Status**: ✅ REMOVED - Data now in JWT claims or API responses

### Tracking/Analytics Cookies ✅ REMOVED

- **PERMANENT_COOKIE** (`pc`) - Long-lived tracking token
- **Status**: ✅ COMPLETELY REMOVED from all flows
- **REFERRER** (`referrer`) - Referrer tracking
- **PARENT_REFERRER** (`referrer`) - Parent page referrer
- **PARENT_URL** (`parent_url`) - Parent page URL
- **Status**: ✅ REMOVED - Now passed as URL parameters instead of cookies

### Test Cookies ✅ REMOVED

- **COOKIE_TEST** (`ct`) - Tests if cookies are enabled
- **Status**: ✅ REMOVED - `launchPrep` endpoint has been deleted

## Completed Work

### 1. JWT-Only Deregister/Logout ✅

- Created `handle_POST_auth_deregister_jwt` that returns JSON without cookie cleanup
- Updated `app.ts` to use the JWT-only handler
- All tests passing

### 2. Participation Init Refactoring ✅

- Removed `getPermanentCookieAndEnsureItIsSet` from `handle_GET_participationInit`
- Modernized the function with async/await
- Simplified the complex Promise logic
- Function is now much cleaner and easier to understand

### 3. LaunchPrep Cleanup ✅

- Removed `setPermanentCookie` from `handle_GET_launchPrep`
- Cleaned up unused imports
- ✅ **REMOVED ENTIRELY** - The `launchPrep` endpoint has been completely deleted!

### 4. Authentication Routes Cleanup ✅

- Removed `handle_POST_auth_login` (cookie-based login)
- Removed `handle_POST_auth_new` (cookie-based registration)
- Removed `handle_POST_auth_password` (cookie-based password reset)
- Removed `handle_POST_auth_pwresettoken` (cookie-based token validation)
- Updated all routes to use `hybridAuth` instead of legacy `auth`

### 5. Session Management Removal ✅

- Removed all session-related functions from `session.ts`
- Removed `auth_tokens` table references
- Removed `startSession`, `endSession`, `getUserInfoForSessionToken`

### 6. Cookie Infrastructure Cleanup ✅

- ✅ **REMOVED `src/utils/cookies.ts` ENTIRELY**
- Removed cookie parser middleware from server
- Removed all cookie types from TypeScript definitions
- Removed cookie references from participation flow
- Removed cookie references from implicit conversation flow

### 7. Password Reset Migration ✅

- Removed entire `src/routes/password.ts` file
- Password reset now handled by Auth0

### 8. Cookie Infrastructure Cleanup ✅

- ✅ **REMOVED `src/utils/cookies.ts` ENTIRELY**
- Removed cookie parser middleware from server
- Removed all cookie types from TypeScript definitions
- Removed cookie references from participation flow
- Removed cookie references from implicit conversation flow

## Remaining Work ~~(Minimal!)~~

### ~~1. LaunchPrep Decision~~ ✅ COMPLETE

~~The ONLY remaining cookie usage is in `src/routes/launchPrep.ts`:~~

- ~~Sets a "top" cookie with `httpOnly: false`~~
- ~~Purpose unclear - possibly for iframe detection~~
- ~~No server-side code reads this cookie~~
- ~~**Decision needed**: Remove or document why it's needed~~

**UPDATE**: Endpoint has been completely removed! The "top" cookie was part of a legacy browser workaround that is no longer functional.

### ~~2. Final Cookie Cleanup~~ ✅ COMPLETE

~~Once launchPrep is addressed:~~

- ✅ Remove `src/utils/cookies.ts` entirely
- ✅ Remove cookie parser middleware from server
- ✅ Remove any remaining cookie types from TypeScript definitions

**UPDATE**: All cookie infrastructure has been successfully removed!

## Benefits Achieved ✅

1. **Simplified Architecture** - No server-side session management
2. **Better Security** - JWTs are more secure than cookies for API auth
3. **Scalability** - Stateless auth scales better
4. **Cross-Domain Support** - JWTs work across domains without CORS cookie issues
5. **Mobile-Friendly** - Better support for mobile apps
6. **Zero Cookie Footprint** - Complete removal of all server-side cookies

## Migration Summary

### What Was Removed

1. **Authentication System**
   - All cookie-based auth functions
   - Session management (`auth_tokens` table)
   - Password reset flows (moved to Auth0)
   - User registration/login endpoints

2. **Cookie Functions**
   - `addCookies()` - Setting auth cookies
   - `clearCookies()` - Clearing on logout
   - `getPermanentCookie()` - Tracking cookies
   - `doCookieAuth()` - Cookie validation
   - `hasAuthToken()` - Auth checks

3. **Route Handlers**
   - `/api/v3/auth/login` - Cookie login
   - `/api/v3/auth/new` - Cookie registration
   - `/api/v3/auth/password` - Password reset
   - `/api/v3/auth/pwresettoken` - Token validation

4. **Tracking/Analytics**
   - Permanent cookie tracking
   - Referrer cookies (now URL params)
   - Parent URL cookies (now URL params)

### What Remains

**UPDATE**: Nothing! All cookie-related code has been removed.

## Success Criteria ✅

- [x] All authentication uses JWT tokens
- [x] No cookie-related code in authentication flows
- [x] All tests pass with JWT-only auth
- [x] No regression in user experience
- [x] Improved security with stateless auth
- [x] Complete removal of cookies.ts ✅

## Timeline

- **Weeks 1-4**: ✅ COMPLETED
- **Week 5**: ✅ COMPLETED - LaunchPrep removed and final cleanup done!

## Notes

- **100% cookie removal achieved!** 🎉
- The `launchPrep` endpoint was a legacy browser workaround that is no longer needed
- System is now completely JWT-based
- All legacy cookie code successfully eliminated
- Zero cookies are now set or read by the Polis server
