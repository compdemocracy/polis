'use strict';
// Run inside the isolated OIDC simulator. Its generated signing key never
// leaves that container; keep the short-lived fixture tokens out of the corpus.
const {createJsonWebToken}=require('@simulacrum/auth0-simulator/dist/auth/jwt.js');
const now=Math.floor(Date.now()/1000);
const claims={iss:'https://localhost:58951/',aud:'users',sub:'generated-selection-account',email:'generated-selection@example.invalid',iat:now,exp:now+86400};
process.stdout.write(JSON.stringify({valid:createJsonWebToken(claims)}));
