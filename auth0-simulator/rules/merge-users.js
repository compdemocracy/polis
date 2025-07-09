function mergeUsers(user, context, callback) {
  // This rule simulates user merging for duplicate emails
  // In the simulator, we detect duplicates by checking user_id patterns
  
  const namespace = 'https://pol.is/';
  
  // Extract the numeric suffix from user_id (e.g., "auth0|test_2" -> 2)
  const userIdMatch = user.user_id.match(/auth0\|test_(\d+)$/);
  
  if (userIdMatch) {
    const userIndex = parseInt(userIdMatch[1]);
    
    // In our test setup, duplicate users have sequential indices
    // Primary account has the lowest index for each email
    // Check if this might be a duplicate by looking at the index
    
    // For test users with indices 0-2, these could be our standard users
    // that might have duplicates (admin, moderator, admin duplicate)
    if (userIndex <= 2) {
      // Determine if this is likely a primary or duplicate account
      // In our setup: index 0 = admin primary, index 1 = moderator, index 2 = admin duplicate
      const isPrimary = userIndex === 0 || userIndex === 1;
      
      if (!isPrimary) {
        console.log(`Detected potential duplicate account: ${user.email} (${user.user_id})`);
        
        // Mark as a merged account
        context.accessToken[`${namespace}merged`] = true;
        context.accessToken[`${namespace}duplicate_detected`] = true;
        
        // In a real scenario, we would:
        // 1. Query for all users with this email
        // 2. Find the primary (oldest) account
        // 3. Use the primary account's data
        // 4. Link the accounts
        
        // For simulation, we'll add a flag indicating this account was processed
        context.idToken[`${namespace}merge_processed`] = true;
      } else {
        console.log(`Primary account detected: ${user.email} (${user.user_id})`);
        
        // For primary accounts that might have duplicates
        if (user.email === 'admin@polis.test') {
          context.accessToken[`${namespace}has_linked_accounts`] = true;
        }
      }
    }
  }
  
  // Add merge metadata for all users
  context.accessToken[`${namespace}account_id`] = user.user_id;
  context.accessToken[`${namespace}merge_check_performed`] = true;
  
  // Log merge activity
  console.log(`Merge users rule executed for: ${user.email} (${user.user_id})`);
  
  callback(null, user, context);
} 