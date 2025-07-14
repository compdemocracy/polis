const https = require('https');
// No need to import fetch - it's a global in Node.js 18+

// Ignore self-signed certificate errors for testing
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

async function testAuth() {
  const audience = 'users';
  const authUrl = 'https://localhost:3000';
  const clientId = 'dev-client-id';
  const namespace = 'https://pol.is/';
  
  console.log('Testing OIDC simulator with custom claims...\n');
  
  try {
    // First, let's check if the server is responding
    console.log('Checking server health...');
    const healthResponse = await fetch(`${authUrl}/.well-known/jwks.json`);
    console.log(`Health check status: ${healthResponse.status}`);
    
    if (!healthResponse.ok) {
      const healthText = await healthResponse.text();
      console.log('Health check response:', healthText);
      return;
    }
    
    console.log('✅ Server is responding, attempting auth...\n');
    
    // Get a token using password grant
    const tokenResponse = await fetch(`${authUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'password',
        username: 'admin@polis.test',
        password: 'Te$tP@ssw0rd*',
        client_id: clientId,
        audience: audience,
        scope: 'openid profile email'
      })
    });
    
    console.log(`Token response status: ${tokenResponse.status}`);
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.log('Error response body:', errorText);
      return;
    }
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.access_token) {
      console.log('✅ Successfully obtained token\n');
      
      // Decode the JWT to inspect claims
      const [header, payload, signature] = tokenData.access_token.split('.');
      const decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString());
      
      console.log('Access Token Claims:');
      console.log(JSON.stringify(decodedPayload, null, 2));
      
      // Check for custom namespace claims
      if (decodedPayload[`${namespace}email`]) {
        console.log('\n✅ Custom namespace claims found!');
        console.log(`- ${namespace}email: ${decodedPayload[`${namespace}email`]}`);
        console.log(`- ${namespace}name: ${decodedPayload[`${namespace}name`]}`);
        
        // Check for merge-related claims
        if (decodedPayload[`${namespace}merged`]) {
          console.log(`- ${namespace}merged: ${decodedPayload[`${namespace}merged`]}`);
        }
        if (decodedPayload[`${namespace}merge_check_performed`]) {
          console.log(`- ${namespace}merge_check_performed: ${decodedPayload[`${namespace}merge_check_performed`]}`);
        }
      } else {
        console.log('\n❌ Custom namespace claims NOT found');
      }
      
      if (tokenData.id_token) {
        const [idHeader, idPayload, idSignature] = tokenData.id_token.split('.');
        const decodedIdPayload = JSON.parse(Buffer.from(idPayload, 'base64').toString());
        console.log('\nID Token Claims:');
        console.log(JSON.stringify(decodedIdPayload, null, 2));
        
        // Check for custom claims in ID token too
        if (decodedIdPayload[`${namespace}email`]) {
          console.log('\n✅ Custom namespace claims also found in ID token!');
        }
      }
    } else {
      console.log('❌ Failed to obtain token:', tokenData);
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Wait a moment for the server to be ready, then test
setTimeout(testAuth, 2000); 