"use strict";
// Executed only inside the local simulator; private keys never leave it.
const {
  createJsonWebToken,
} = require("@simulacrum/auth0-simulator/dist/auth/jwt.js");
const claims = {
  iss: "https://oidc-simulator:3000/",
  aud: "users",
  sub: "generated-identity-user",
  email: "identity@example.invalid",
  name: "Generated Identity",
  nickname: "identity",
  iat: 1699999999,
  exp: 1700086400,
};
process.stdout.write(
  JSON.stringify({
    "oidc-first": createJsonWebToken(claims),
    "oidc-missing-email": createJsonWebToken({
      ...claims,
      sub: "generated-identity-no-email",
      email: undefined,
    }),
    "oidc-refusal": createJsonWebToken({
      ...claims,
      sub: "generated-identity-refusal",
      email: "refusal@example.invalid",
    }),
    "oidc-expired": createJsonWebToken({ ...claims, exp: 1 }),
    "oidc-signature": createJsonWebToken(claims).replace(
      /\.[^.]+$/,
      ".generated"
    ),
  })
);
