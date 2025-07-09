# Auth0 Simulator Rules

This directory contains Auth0-compatible rules that add custom functionality to the authentication flow.

## Available Rules

### 1. `add-custom-claims.js`

Adds custom namespace claims to JWT tokens for all users:

- `https://pol.is/email`
- `https://pol.is/name`
- `https://pol.is/email_verified`

### 2. `merge-users.js`

Basic merge detection based on user_id patterns. This is a simplified implementation for testing.

### 3. `merge-users-enhanced.js` (disabled by default)

A more sophisticated example showing how merge logic would work in production with proper duplicate detection.

## Limitations

The simulacrum auth0-simulator has some limitations compared to real Auth0:

1. **No Management API**: Rules cannot query for other users with the same email
2. **Limited User Data**: Only basic user properties are available
3. **No External Services**: Cannot make HTTP requests to external APIs
4. **No Account Linking**: Cannot actually link/merge accounts

## Best Practices for Production

In a real Auth0 environment, you would:

1. Use the Management API to find duplicate users by email
2. Determine the primary account (usually the oldest)
3. Use Auth0's account linking feature
4. Store merge metadata in user app_metadata

## Example Production Rule

```javascript
function mergeAccountsProduction(user, context, callback) {
  const ManagementClient = require('auth0').ManagementClient;
  const namespace = 'https://yourdomain.com/';
  
  // Initialize Management API client
  const management = new ManagementClient({
    token: auth0.accessToken,
    domain: auth0.domain
  });
  
  // Search for users with same email
  management.getUsersByEmail(user.email, (err, users) => {
    if (err) return callback(err);
    
    if (users.length > 1) {
      // Find primary (oldest) account
      const primary = users.reduce((oldest, current) => 
        new Date(current.created_at) < new Date(oldest.created_at) ? current : oldest
      );
      
      // Add claims based on primary account
      context.accessToken[`${namespace}primary_user_id`] = primary.user_id;
      context.accessToken[`${namespace}account_linked`] = user.user_id !== primary.user_id;
    }
    
    callback(null, user, context);
  });
}
```

## Testing Rules

To test the rules with the simulator:

```bash
# Start the simulator
npm start

# Run the test script
node test-auth.js
```

The test script will show you the JWT claims including any custom namespace claims added by the rules.
