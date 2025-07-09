// THIS FILE IS FOR REFERENCE ONLY.
// IT IS A COPY OF THE CUSTOM TRIGGER USED IN AUTH0.

/**
* Handler that will be called during the execution of a PostLogin flow.
*
* @param {Event} event - Details about the user and the context in which they are logging in.
* @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
*/
exports.onExecutePostLogin = async (event, api) => {
  const axios = require("axios");
  const ManagementClient = require("auth0").ManagementClient;

  // This object will hold the user profile we want to use.
  // It starts as the currently logged-in user.
  let finalUser = event.user;

  // --- Start of User Merge Logic ---
  const { CLIENT_ID, CLIENT_SECRET } = event.secrets;
  let access_token;

  if (CLIENT_ID && CLIENT_SECRET) {
      try {
          const tokenResponse = await axios.post(
              "https://compdem.us.auth0.com/oauth/token",
              {
                  grant_type: "client_credentials",
                  client_id: CLIENT_ID,
                  client_secret: CLIENT_SECRET,
                  audience: "https://compdem.us.auth0.com/api/v2/",
              },
              { headers: { "content-type": "application/json" } }
          );
          access_token = tokenResponse.data.access_token;
      } catch (error) {
          console.log("Error getting management token:", error.message);
      }
  }

  if (access_token) {
    const management = new ManagementClient({
      token: access_token,
      domain: "compdem.us.auth0.com",
    });

    try {
      const { data: users } = await management.usersByEmail.getByEmail({ email: event.user.email });
      console.log('Users count for email', event.user.email, 'is', users.length);

      // This logic runs only when merging a new account into an existing one.
      if (users.length === 2) {
        // NOTE: This assumes a specific ordering, which might need adjustment.
        // It's safer to identify the primary account based on creation date or identity provider.
        // For now, we'll assume users[1] is the primary account.
        const primaryUser = users[1];
        const secondaryUser = users[0];

        await management.users.link({ id: primaryUser.user_id }, {
          user_id: secondaryUser.user_id,
          provider: secondaryUser.identities[0].provider,
        });

        // After linking, we'll use the primary user's profile for the token.
        finalUser = primaryUser;
        console.log('Successfully linked accounts. Using primary user:', finalUser.user_id);
      }
    } catch (err) {
      console.log("Error during user merge logic: ", err.message);
      // If merging fails, we'll fall through and use the original user.
    }
  }
  // --- End of User Merge Logic ---


  // --- Add Profile to Access Token ---
  // This part now runs *after* the merge logic, using the correct user profile.
  const namespace = 'https://pol.is/';
  if (event.authorization && finalUser) {
    api.accessToken.setCustomClaim(`${namespace}email`, finalUser.email);
    api.accessToken.setCustomClaim(`${namespace}name`, finalUser.name);
  }
};