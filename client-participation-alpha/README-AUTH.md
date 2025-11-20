# Authentication and JWT Handling in Client-Participation-Alpha

## Overview

The alpha client now has centralized JWT and authentication handling that mirrors the legacy client's approach but with modern patterns. All JWT tokens are automatically extracted and stored from API responses, and authentication headers are automatically added to requests.

## Key Components

### 1. `auth.ts` - Authentication Management

- `setJwtToken(token)` - Stores JWT tokens per conversation (extracts conversation_id from token)
- `getConversationToken(conversation_id)` - Retrieves stored JWT for a specific conversation
- `handleJwtFromResponse(response)` - Automatically extracts and stores JWT from API responses
- `getConversationIdFromUrl()` - Extracts conversation_id from URL path (e.g., /alpha/2demo → "2demo")

### 2. `net.js` - Network Layer with Auto-Auth

- Automatically adds authentication headers to all requests
- Automatically extracts and stores JWT tokens from all responses
- Handles both OIDC tokens and conversation-specific JWTs
- Provides consistent error handling with auth error details

## Usage Examples

### Simple API Call (JWT handled automatically)

```javascript
import PolisNet from '../lib/net';

// Make an API call - JWT will be automatically added to headers if available
// and automatically extracted/stored from response
const result = await PolisNet.polisPost('/api/v3/votes', {
  conversation_id: 'abc123',
  tid: 42,
  vote: 1
});
// No need to manually handle result.auth.token - it's done automatically!
```

### Component Example

```javascript
import PolisNet from '../lib/net';
import { getConversationToken } from '../lib/auth';

export function MyComponent({ conversation_id }) {
  const submitData = async (data) => {
    // Get current participant info if needed
    const token = getConversationToken(conversation_id);
    const pid = token?.pid;
    
    try {
      // Make API call - auth headers added automatically
      const response = await PolisNet.polisPost('/api/v3/comments', {
        conversation_id,
        pid,
        txt: data.text
      });
      
      // JWT token from response.auth.token is automatically stored
      // No manual handling needed!
      
      return response;
    } catch (error) {
      // Error includes responseText for server error messages
      console.error('API Error:', error.responseText || error.message);
      throw error;
    }
  };
}
```

## URL Structure and Conversation ID

The conversation_id is extracted from the URL path, not query parameters:

- `https://pol.is/alpha/2demo` → conversation_id: "2demo"
- `http://localhost:4321/3xyz` → conversation_id: "3xyz"
- `https://edge.pol.is/alpha/4abc` → conversation_id: "4abc"

The pattern matches:

- `/alpha/:conversation_id` (production)
- `/:conversation_id` (development)

Conversation IDs always start with a digit followed by alphanumeric characters.

## Authentication Flow

1. **Initial Page Load (SSR)**
   - Server fetches initial data with participationInit
   - JWT token included in response
   - Client-side script stores token on hydration

2. **Subsequent API Calls**
   - `net.js` checks for OIDC token first
   - Falls back to conversation-specific JWT (extracted from URL path)
   - Automatically adds to Authorization header
   - Server responds with updated JWT if needed
   - `net.js` automatically stores new JWT

3. **Token Priority**
   - OIDC tokens (if available) take precedence
   - Conversation-specific JWTs used as fallback (based on current URL)
   - No token sent if neither available (anonymous access)

## XID (External Identifier) Support

The alpha client supports XID-based authentication for integrating with external systems:

### How XID Works

1. **XID Detection**
   - XID is read from URL query parameters: `?xid=user123`
   - Additional params supported: `?x_name=John&x_profile_image_url=https://...`
   - For embeds, use data attributes: `<div data-xid="user123" data-x_name="John">`

2. **Automatic XID Inclusion**
   - `net.ts` automatically includes XID params in all API requests
   - XID from URL is preserved across all API calls during the session
   - No manual handling needed - it's automatic like JWT

3. **XID Error Handling**
   - `polis_err_xid_required`: Shown when conversation requires XID but none provided
   - Error messages displayed inline using existing UI components
   - User-friendly error messages from string files

4. **OIDC + XID Conflict Warning**
   - If user has both OIDC token AND XID parameter, a warning banner appears
   - Warning is dismissible but alerts user to potential conflict
   - Recommendation: Log out of OIDC account to participate with XID

### XID Functions in auth.ts

- `getXidFromUrl()` - Get XID from current URL query params
- `getXNameFromUrl()` - Get x_name from URL
- `getXProfileImageUrlFromUrl()` - Get x_profile_image_url from URL
- `isOidcAuthenticated()` - Check if user is logged in via OIDC (for conflict detection)

## Migration from Manual JWT Handling

### Before (Manual JWT Handling)

```javascript
// DON'T DO THIS ANYMORE
const response = await fetch('/api/v3/votes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});

const result = await response.json();

// Manual JWT extraction and storage
if (result?.auth?.token) {
  const token = result.auth.token;
  const parts = token.split('.');
  if (parts.length === 3) {
    const payload = JSON.parse(atob(parts[1]));
    if (payload.conversation_id) {
      localStorage.setItem('participant_token_' + payload.conversation_id, token);
    }
  }
}
```

### After (Centralized Handling)

```javascript
// DO THIS INSTEAD
import PolisNet from '../lib/net';

const result = await PolisNet.polisPost('/api/v3/votes', data);
// JWT handling is automatic - no manual code needed!
```

## Benefits

1. **DRY Principle** - JWT handling logic in one place
2. **Consistency** - All API calls handle auth the same way
3. **Error Handling** - Centralized auth error handling
4. **Maintainability** - Easy to update auth logic globally
5. **Type Safety** - TypeScript interfaces for auth objects
6. **Automatic Token Refresh** - Server can send new tokens anytime

## Comparison with Legacy Client

| Feature | Legacy Client | Alpha Client |
|---------|--------------|--------------|
| JWT Storage | `polisStorage.js` | `auth.ts` |
| Auto JWT Extraction | ✅ `net.js`, `main.js` | ✅ `net.js` |
| Auto Auth Headers | ✅ `backbonePolis.js` | ✅ `net.js` |
| OIDC Support | ❌ | ✅ |
| TypeScript | ❌ | ✅ |
| Centralized | Partial (3 files) | ✅ (2 files) |

## Testing

When testing components that use the network layer:

```javascript
// Mock the net module
jest.mock('../lib/net', () => ({
  polisPost: jest.fn(),
  polisGet: jest.fn(),
  polisPut: jest.fn()
}));

// In tests
import PolisNet from '../lib/net';

PolisNet.polisPost.mockResolvedValue({
  success: true,
  auth: { token: 'mock-jwt-token' }
});
```

## Troubleshooting

1. **No auth header sent**: Check if token exists for conversation
2. **401 errors**: Token may be expired or invalid
3. **403 errors**: User lacks permission for action
4. **Token not stored**: Check browser storage settings
5. **OIDC vs JWT conflicts**: OIDC takes precedence when available
