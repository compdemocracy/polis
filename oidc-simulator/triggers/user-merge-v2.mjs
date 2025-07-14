// IMPROVED VERSION OF THE AUTH0 MERGE USERS TRIGGER
// This file contains suggested improvements for the production Auth0 trigger

/**
* Handler that will be called during the execution of a PostLogin flow.
*
* @param {Event} event - Details about the user and the context in which they are logging in.
* @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
*/
exports.onExecutePostLogin = async (event, api) => {
  const axios = require("axios");
  const ManagementClient = require("auth0").ManagementClient;

  // Configuration
  const namespace = 'https://pol.is/';
  const DOMAIN = event.secrets.AUTH0_DOMAIN || "compdem.us.auth0.com";
  
  // Early exit for certain scenarios
  if (event.user.app_metadata?.merge_completed) {
    console.log('User already has completed merge, skipping merge logic');
    addCustomClaims(event.user, api, namespace);
    return;
  }

  // This object will hold the user profile we want to use.
  let finalUser = event.user;

  // --- Improved User Merge Logic ---
  const { CLIENT_ID, CLIENT_SECRET } = event.secrets;
  
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing CLIENT_ID or CLIENT_SECRET in secrets');
    addCustomClaims(finalUser, api, namespace);
    return;
  }

  let management;
  
  try {
    // Get Management API access token
    const tokenResponse = await axios.post(
      `https://${DOMAIN}/oauth/token`,
      {
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        audience: `https://${DOMAIN}/api/v2/`,
      },
      { 
        headers: { "content-type": "application/json" },
        timeout: 5000 // Add timeout to prevent hanging
      }
    );

    management = new ManagementClient({
      token: tokenResponse.data.access_token,
      domain: DOMAIN,
    });

  } catch (error) {
    console.error("Error getting management token:", error?.message || String(error) || 'Unknown error');
    // Continue with login but without merge functionality
    addCustomClaims(finalUser, api, namespace);
    return;
  }

  try {
    // Search for all users with the same email
    const { data: users } = await management.usersByEmail.getByEmail({ 
      email: event.user.email?.toLowerCase() || '' // Normalize email safely
    });
    
    console.log(`Found ${users.length} user(s) with email: ${event.user.email}`);

    if (users.length > 1) {
      // Find the primary account (oldest created_at)
      const sortedUsers = users.sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      
      const primaryUser = sortedUsers[0];
      const currentUser = users.find(u => u.user_id === event.user.user_id);
      
      console.log(`Primary user: ${primaryUser.user_id} (created: ${primaryUser.created_at})`);
      console.log(`Current user: ${currentUser.user_id} (created: ${currentUser.created_at})`);

      // Only merge if current user is not the primary
      if (currentUser.user_id !== primaryUser.user_id) {
        console.log(`Attempting to link ${currentUser.user_id} to primary account ${primaryUser.user_id}`);
        
        // Check if accounts are already linked
        const alreadyLinked = primaryUser.identities?.some(
          identity => identity.user_id === currentUser.user_id.split('|')[1]
        );

        if (!alreadyLinked) {
          // Link the accounts
          await management.users.link(
            { id: primaryUser.user_id }, 
            {
              user_id: currentUser.user_id,
              provider: currentUser.identities[0].provider,
            }
          );

          // Update user metadata to indicate merge completion
          await management.users.update(
            { id: primaryUser.user_id },
            { 
              app_metadata: { 
                merge_completed: true,
                merge_date: new Date().toISOString(),
                linked_accounts: users.length
              }
            }
          );

          console.log('Successfully linked accounts');
          
          // Use the primary user's profile for claims
          finalUser = primaryUser;
          
          // Add merge information to the token
          api.accessToken.setCustomClaim(`${namespace}account_linked`, true);
          api.accessToken.setCustomClaim(`${namespace}primary_user_id`, primaryUser.user_id);
          api.accessToken.setCustomClaim(`${namespace}linked_from`, currentUser.user_id);
        } else {
          console.log('Accounts already linked, using primary user profile');
          finalUser = primaryUser;
        }
      } else {
        console.log('Current user is already the primary account');
        
        // Add metadata about linked accounts
        if (users.length > 1) {
          api.accessToken.setCustomClaim(`${namespace}has_linked_accounts`, true);
          api.accessToken.setCustomClaim(`${namespace}linked_accounts_count`, users.length - 1);
        }
      }
    }
    
  } catch (err) {
    const errorMessage = err?.message || String(err) || 'Unknown error';
    console.error("Error during user merge logic:", errorMessage);
    
    // Safely extract error details
    const errorDetails = err?.response?.data || errorMessage;
    try {
      console.error("Error details:", JSON.stringify(errorDetails));
    } catch {
      console.error("Error details:", String(errorDetails));
    }
    
    // Add error information to token for debugging (remove in production)
    if (event.secrets.DEBUG_MODE === 'true') {
      api.accessToken.setCustomClaim(`${namespace}merge_error`, errorMessage);
    }
    
    // Continue with login using original user
  }

  // --- Add Custom Claims ---
  addCustomClaims(finalUser, api, namespace);
};

/**
 * Helper function to add custom claims to tokens
 */
function addCustomClaims(user, api, namespace) {
  if (!api.accessToken || !user) {
    console.error('Missing api.accessToken or user object');
    return;
  }

  // Add user profile claims
  api.accessToken.setCustomClaim(`${namespace}email`, user.email);
  api.accessToken.setCustomClaim(`${namespace}name`, user.name || user.nickname || user.email);
  api.accessToken.setCustomClaim(`${namespace}email_verified`, user.email_verified || false);
  api.accessToken.setCustomClaim(`${namespace}user_id`, user.user_id);
  
  // Add metadata if available
  if (user.user_metadata) {
    api.accessToken.setCustomClaim(`${namespace}user_metadata`, user.user_metadata);
  }
  
  // Add merge status
  if (user.app_metadata?.merge_completed) {
    api.accessToken.setCustomClaim(`${namespace}merge_completed`, true);
    api.accessToken.setCustomClaim(`${namespace}merge_date`, user.app_metadata.merge_date);
  }
  
  // Add timestamp for debugging
  api.accessToken.setCustomClaim(`${namespace}issued_at`, new Date().toISOString());
} 