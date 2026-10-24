"use strict";
// Run on stdin in the isolated simulator container. Use its own test signing
// implementation without copying a key into the source, artifacts or logs.
const { createJsonWebToken } = require("@simulacrum/auth0-simulator/dist/auth/jwt.js");
const claims = {
  iss: "https://oidc-simulator:3000/", aud: "users",
  sub: "generated-oidc-vote-fixture", email: "generated-oidc@example.invalid",
  iat: 1699999999, exp: 1700086400,
};
const valid = createJsonWebToken(claims);
const missingEmail = { ...claims, sub: "generated-oidc-no-email" };
delete missingEmail.email;
process.stdout.write(JSON.stringify({
  "oidc-missing-email": createJsonWebToken(missingEmail),
  "oidc-expired": createJsonWebToken({ ...claims, exp: 1 }),
  "oidc-issuer": createJsonWebToken({ ...claims, iss: "https://invalid.example/" }),
  "oidc-audience": createJsonWebToken({ ...claims, aud: "generated-other" }),
  "oidc-signature": valid.slice(0, valid.lastIndexOf(".") + 1) + "generated",
  "oidc-unknown-key": createJsonWebToken(claims, undefined, {
    algorithm: "RS256", keyid: "generated-unpublished-key",
  }),
}));
