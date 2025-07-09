function addCustomClaims(user, context, callback) {
  // Define the namespace for custom claims
  const namespace = 'https://pol.is/';
  
  // Add custom claims to the access token
  context.accessToken[`${namespace}email`] = user.email;
  context.accessToken[`${namespace}name`] = user.name || user.email;
  context.accessToken[`${namespace}email_verified`] = user.email_verified || false;
  
  // Add custom claims to the ID token as well
  context.idToken[`${namespace}email`] = user.email;
  context.idToken[`${namespace}name`] = user.name || user.email;
  context.idToken[`${namespace}email_verified`] = user.email_verified || false;
  
  // Log for debugging
  console.log('Added custom claims for user:', user.email);
  console.log('Access token claims:', context.accessToken);
  
  callback(null, user, context);
} 