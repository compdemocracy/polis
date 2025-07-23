function mergeUsers(user, context, callback) {
  // This is a simplified rule for the OIDC simulator.
  // The production merge logic is complex and cannot be fully replicated here
  // because the simulator's sandboxed rule environment does not allow
  // accessing a shared state (like the 'global' object) or a database
  // to find other user accounts.
  
  // This simplified version focuses on the primary goal for testing:
  // ensuring custom claims are correctly added to the access token.

  const namespace = 'https://pol.is/';
  addCustomClaims(user, context, namespace);

  /**
   * Helper function to add custom claims to tokens
   * Simulates the addCustomClaims function from the production Action
   */
  function addCustomClaims(user, context, namespace) {
    if (!context.accessToken || !user) {
      console.error('Missing context.accessToken or user object');
      return;
    }

    // Add user profile claims (matching production Action)
    context.accessToken[`${namespace}email`] = user.email;
    context.accessToken[`${namespace}name`] = user.name || user.nickname || user.email;
    context.accessToken[`${namespace}email_verified`] = user.email_verified || false;
    context.accessToken[`${namespace}user_id`] = user.user_id;

    // Add metadata if available
    if (user.user_metadata) {
      context.accessToken[`${namespace}user_metadata`] = user.user_metadata;
    }

    // Add merge status
    if (user.app_metadata && user.app_metadata.merge_completed) {
      context.accessToken[`${namespace}merge_completed`] = true;
      context.accessToken[`${namespace}merge_date`] = user.app_metadata.merge_date;
    }

    // Add timestamp for debugging
    context.accessToken[`${namespace}issued_at`] = new Date().toISOString();

    // Add simulator indicator
    context.accessToken[`${namespace}simulator`] = true;
  }

  console.log(`Enhanced merge rule executed for: ${user.email}`);
  callback(null, user, context);
}
