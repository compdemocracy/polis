function mergeUsersEnhanced(user, context, callback) {
  // Enhanced merge users rule that demonstrates best practices
  // In production, this would use the Auth0 Management API to query users
  
  const namespace = 'https://pol.is/';
  
  // In a real Auth0 environment, you would:
  // 1. Use the Management API to search for users with the same email
  // 2. Determine the primary account (usually oldest created_at)
  // 3. Link accounts if needed
  // 4. Use the primary account's profile data
  
  // For the simulator, we'll add metadata that indicates merge logic ran
  context.accessToken[`${namespace}merge_policy`] = 'enhanced';
  context.accessToken[`${namespace}user_id`] = user.user_id;
  context.accessToken[`${namespace}original_email`] = user.email;
  
  // Simulate checking for duplicates by examining the user object
  // In the simulator, we can look for certain patterns that indicate
  // this might be a duplicate account
  
  // Check if user was created recently (might indicate a duplicate)
  if (user.created_at) {
    const createdDate = new Date(user.created_at);
    const now = new Date();
    const hoursSinceCreation = (now - createdDate) / (1000 * 60 * 60);
    
    // If account was created very recently, it might be a duplicate
    if (hoursSinceCreation < 1) {
      context.accessToken[`${namespace}recently_created`] = true;
      console.log(`Recently created account detected: ${user.email} (created ${hoursSinceCreation.toFixed(2)} hours ago)`);
    }
  }
  
  // Check for common duplicate patterns in the email or name
  if (user.name && user.name.includes('Duplicate')) {
    context.accessToken[`${namespace}potential_duplicate`] = true;
    context.accessToken[`${namespace}merge_recommended`] = true;
    console.log(`Potential duplicate detected based on name: ${user.name}`);
  }
  
  // Add a unique session identifier for tracking
  context.accessToken[`${namespace}merge_session`] = `merge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // In production, you would typically:
  // - Check a custom user metadata field to see if accounts have been linked
  // - Use app_metadata to store the primary account ID
  // - Implement account linking on first duplicate login
  
  // Example of what production code might look like (commented out as it won't work in simulator):
  /*
  const ManagementClient = require('auth0').ManagementClient;
  const management = new ManagementClient({
    domain: auth0.domain,
    clientId: configuration.MANAGEMENT_CLIENT_ID,
    clientSecret: configuration.MANAGEMENT_CLIENT_SECRET
  });
  
  management.getUsersByEmail(user.email, function(err, users) {
    if (!err && users.length > 1) {
      // Find primary account (oldest)
      const primaryUser = users.reduce((oldest, current) => 
        new Date(current.created_at) < new Date(oldest.created_at) ? current : oldest
      );
      
      // Link accounts if this is not the primary
      if (user.user_id !== primaryUser.user_id) {
        context.accessToken[`${namespace}linked_to`] = primaryUser.user_id;
      }
    }
    callback(null, user, context);
  });
  */
  
  console.log(`Enhanced merge rule executed for: ${user.email}`);
  callback(null, user, context);
} 