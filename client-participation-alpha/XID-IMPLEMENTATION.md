# XID Implementation for Client-Participation-Alpha

## Overview

This document describes the XID (External Identifier) implementation for the client-participation-alpha app. XID support allows external systems to integrate with Polis by providing user identifiers via URL parameters.

## Implementation Summary

### 1. Auth Module (`src/lib/auth.ts`)

Added the following functions:

- **`getXidFromUrl()`** - Extracts `xid` parameter from URL query string
- **`getXNameFromUrl()`** - Extracts `x_name` parameter from URL
- **`getXProfileImageUrlFromUrl()`** - Extracts `x_profile_image_url` parameter from URL
- **`isOidcAuthenticated()`** - Checks if user has valid OIDC token (for conflict detection)

### 2. Network Module (`src/lib/net.ts`)

Modified to automatically include XID parameters in all API requests:

- **`polisFetch()`** - Enriches request data with XID params from URL
- **`downloadCsv()`** - Includes XID params in CSV download requests
- XID params are only added if not already present in the request data
- Works for both GET and POST/PUT requests

### 3. Error Handling

Added `polis_err_xid_required` error handling in multiple locations:

#### Page Level (`src/pages/[conversation_id].astro`)

- Catches XID errors during SSR data fetch
- Shows user-friendly error message instead of generic error

#### Survey Component (`src/components/Survey.jsx`)

- Handles XID errors when voting on statements
- Shows inline error message using existing UI

#### Survey Form Component (`src/components/SurveyForm.jsx`)

- Handles XID errors when submitting comments
- Shows inline error message
- Restores user's text if submission fails (so they don't lose their work)

#### Topic Agenda Component (`src/components/topicAgenda/TopicAgenda.jsx`)

- Handles XID errors when submitting topic selections
- Shows inline error message below topic grid
- Also shows success message that auto-dismisses after 3 seconds

### 4. OIDC + XID Conflict Warning

Created new component: **`src/components/XidOidcConflictWarning.jsx`**

- Detects when user has both OIDC authentication AND XID parameter
- Shows dismissible warning banner at top of page
- Uses warning styling (yellow/amber colors)
- Recommends logging out of OIDC to use XID

Added to conversation page (`[conversation_id].astro`) with `client:load` directive.

### 5. Internationalization

Added new strings to `src/strings/en_us.js`:

```javascript
s.xidRequired = "This conversation requires an XID (external identifier) to participate. Please use the proper link provided to you.";
s.xidOidcConflictWarning = "Warning: You are currently signed-in to polis, but have opened a conversation with an XID token. To participate with an XID, please log out of your polis account.";
```

### 6. Documentation

Updated `README-AUTH.md` with comprehensive XID documentation:

- How XID works
- Automatic XID inclusion in requests
- Error handling patterns
- OIDC + XID conflict detection
- API reference for XID functions

## Usage Examples

### Direct URL Access

```
https://pol.is/alpha/2demo?xid=user123&x_name=John%20Doe
```

### Embed Code

```html
<div class='polis' 
     data-conversation_id='2demo' 
     data-xid='user123'
     data-x_name='John Doe'
     data-x_profile_image_url='https://example.com/avatar.jpg'>
</div>
<script async src="https://pol.is/alpha/embed.js"></script>
```

The embed script automatically converts data attributes to query parameters.

## Request Flow

1. **User visits page** with `?xid=user123` in URL
2. **SSR fetch** includes XID in participationInit request
3. **Client-side API calls** automatically include XID from URL
4. **Server responds** with JWT token containing XID
5. **Subsequent requests** use JWT or continue passing XID

## Error Messages

| Error Code | User-Facing Message |
|------------|-------------------|
| `polis_err_xid_required` | "This conversation requires an XID (external identifier) to participate. Please use the proper link provided to you." |
| `polis_err_xid_not_allowed` | "This conversation requires an XID (external identifier) to participate. Please use the proper link provided to you." |
| OIDC + XID conflict | "Warning: You are currently signed-in to polis, but have opened a conversation with an XID token. To participate with an XID, please log out of your polis account." |

## Testing Checklist

- [ ] Visit conversation with `?xid=test123` - verify XID included in requests
- [ ] Try voting with XID - verify vote is recorded
- [ ] Try commenting with XID - verify comment is submitted
- [ ] Try submitting topic selections with XID - verify selections are saved
- [ ] Visit XID-required conversation without XID - verify error message
- [ ] Try voting/commenting/topic selection without XID on XID-required conversation - verify error messages
- [ ] Visit with both OIDC login AND XID - verify warning banner appears
- [ ] Dismiss warning banner - verify it disappears
- [ ] Test embed code with data-xid attribute
- [ ] Verify XID persists across multiple API calls in same session
- [ ] Verify success message appears after successful topic submission
- [ ] Verify error message appears on failed topic submission (with proper error text)

## Architecture Decisions

### Why Automatic XID Inclusion?

Following the same pattern as JWT authentication, XID parameters are automatically included in all API requests. This provides:

1. **Consistency** - Developers don't need to manually add XID to each API call
2. **DRY Principle** - XID logic centralized in one place (net.ts)
3. **Less Error-Prone** - Can't forget to include XID
4. **Future-Proof** - New API calls automatically support XID

### Why Warning Instead of Blocking OIDC+XID?

The warning is dismissible rather than blocking because:

1. User might intentionally be testing both modes
2. Server is the source of truth on which auth to use
3. Better UX to inform rather than prevent
4. Allows admin users to test XID flows while logged in

### Why Inline Errors Instead of Alerts?

Using inline error messages (not browser `alert()`) provides:

1. **Better UX** - Non-intrusive, fits with existing UI
2. **Accessibility** - Screen reader friendly
3. **Consistency** - Matches existing error patterns in app
4. **Modern** - Alert boxes are considered poor UX practice

## Files Modified

- `src/lib/auth.ts` - Added XID getter functions and OIDC check
- `src/lib/net.ts` - Auto-include XID in requests
- `src/components/Survey.jsx` - XID error handling for voting
- `src/components/SurveyForm.jsx` - XID error handling for commenting
- `src/components/topicAgenda/TopicAgenda.jsx` - XID error handling for topic submissions
- `src/components/XidOidcConflictWarning.jsx` - NEW: Conflict warning component
- `src/pages/[conversation_id].astro` - SSR XID handling, warning component, and pass strings to TopicAgenda
- `src/strings/en_us.js` - Added XID error messages
- `README-AUTH.md` - Added XID documentation

## Comparison with Legacy Client

| Feature | Legacy Client (index.ejs) | Alpha Client |
|---------|-------------------------|--------------|
| XID Detection | JavaScript function | TypeScript function in auth.ts |
| Auto-inclusion | Per-request basis | Centralized in net.ts |
| Error Display | Browser `alert()` | Inline UI components |
| OIDC Conflict | Browser `alert()` | Dismissible banner component |
| Documentation | Comments in code | Comprehensive README |
| Testing | Manual | Component-based (test-ready) |

## Future Enhancements

Possible improvements for future iterations:

1. Add XID validation (format checking)
2. Support XID in URL hash for SPA routing
3. Add XID to analytics/telemetry
4. Store XID preferences (e.g., don't show warning again)
5. Add E2E tests for XID flows
6. Support multiple XIDs per conversation (if needed)
