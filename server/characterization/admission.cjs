"use strict";
const local = new Map([
  ["postgres", [5432]],
  ["dynamodb", [8000]],
  ["file-server", [8080]],
  ["oidc-simulator", [3000]],
  ["localhost", [5000]],
  ["127.0.0.1", [5000]],
  ["::1", [5000]],
]);
function assertAttempts(attempts, boot = false) {
  let akismet = 0;
  for (const a of attempts) {
    if (a.service === "DynamoDB") continue;
    if (local.get(a.host)?.includes(a.port) && !a.blocked) continue;
    if (
      boot &&
      a.host === "rest.akismet.com" &&
      a.port === 80 &&
      a.protocol === "http" &&
      a.method === "POST" &&
      a.path === "/1.1/verify-key" &&
      a.blocked &&
      ++akismet === 1
    )
      continue;
    throw Error("unexpected outbound attempt: " + (a.host || a.service));
  }
}
module.exports = { assertAttempts };
