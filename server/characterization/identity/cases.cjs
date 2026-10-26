"use strict";
const cases = [];
function add(name, route, options = {}) {
  cases.push({ name, route, status: 200, auth: "unauthenticated", ...options });
}
add("anonymous-first-vote", "votes", {
  users: 1,
  participants: 1,
  token: "anonymous",
});
add("anonymous-repeat", "votes", { auth: "anonymous-first-vote" });
add("anonymous-other-conversation", "votes", {
  auth: "anonymous-first-vote",
  zid: 2,
  users: 1,
  participants: 1,
  token: "anonymous",
});
for (const route of ["participationInit", "votes", "comments"]) {
  for (const policy of ["off", "allowed", "required"]) {
    add(`bare-xid-${route}-${policy}`, route, {
      policy,
      xid: `generated-${route}-${policy}`,
      users: 1,
      participants: 1,
      xids: 1,
      token: "xid",
    });
  }
  add(`bare-xid-${route}-denied`, route, {
    policy: "allowed",
    xid: "generated-denied",
    status: 403,
    error: "polis_err_xid_not_allowed",
  });
  add(`bare-xid-${route}-required-missing`, route, {
    policy: "required",
    status: route === "participationInit" ? 200 : 403,
    ...(route === "participationInit"
      ? {}
      : { error: "polis_err_xid_required" }),
  });
  add(`bare-xid-${route}-allowed-missing`, route, {
    policy: "allowed",
    status: route === "participationInit" ? 200 : 403,
    ...(route === "participationInit"
      ? {}
      : { error: "polis_err_xid_required" }),
  });
}
add("xid-own-conversation", "votes", { auth: "bare-xid-votes-off" });
add("xid-other-conversation", "votes", {
  auth: "bare-xid-votes-off",
  zid: 2,
  participants: 1,
  token: "xid",
});
add("xid-other-owner", "votes", {
  auth: "bare-xid-votes-off",
  zid: 3,
  users: 1,
  participants: 1,
  xids: 1,
  token: "xid",
});
add("xid-request-precedence", "votes", {
  auth: "bare-xid-votes-off",
  xid: "generated-request-wins",
  users: 1,
  participants: 1,
  xids: 1,
  token: "xid",
});
add("standard-user-first-join", "votes", {
  auth: "standard",
  zid: 2,
  participants: 1,
  token: "standard_user",
});
add("standard-user-repeat", "votes", {
  auth: "standard-user-first-join",
  zid: 2,
});
add("oidc-first-use", "votes", {
  auth: "oidc-first",
  users: 1,
  mappings: 1,
  participants: 1,
});
add("oidc-repeat", "votes", { auth: "oidc-first" });
add("pc-anonymous", "votes", {
  cookie: "generated-anonymous-cookie",
  token: "anonymous",
});
add("pc-xid", "votes", {
  cookie: "generated-xid-cookie",
  token: "xid",
  xid: "generated-cookie-member",
});
add("treevite-refused-first-join", "votes", {
  policy: "treevite",
  users: 1,
  status: 401,
  error: "polis_err_treevite_auth_required",
});
add("xid-upsert-failure", "votes", {
  xid: "generated-retry-xid",
  fault: "xid",
  users: 1,
  participants: 1,
  status: 500,
  text: "Internal Server Error\n",
});
add("xid-upsert-retry", "votes", {
  xid: "generated-retry-xid",
  users: 1,
  participants: 1,
  xids: 1,
  token: "xid",
});
add("treevite-accept", "treevite/acceptInvite", {
  policy: "treevite",
  status: 201,
  users: 1,
  participants: 1,
  token: "anonymous",
});
add("treevite-login", "treevite/login", {
  policy: "treevite",
  token: "anonymous",
});
add("treevite-used-invite", "treevite/acceptInvite", {
  policy: "treevite",
  status: 400,
  error: "polis_err_treevite_invalid_or_used_invite",
});
add("treevite-invalid-login", "treevite/login", {
  policy: "treevite",
  status: 401,
  error: "polis_err_treevite_login_code_invalid",
});
add("required-no-token", "participation", {
  status: 401,
  error: "No authentication token found",
});
add("required-wrong-prefix", "participation", {
  prefix: "bearer generated",
  status: 401,
  error: "No authentication token found",
});
add("unknown-token-shape", "votes", {
  auth: "bad",
  status: 401,
  error: "Invalid token format",
});
for (const auth of [
  "anonymous-expired",
  "xid-expired",
  "standard-expired",
  "oidc-expired",
  "anonymous-signature",
  "xid-signature",
  "standard-signature",
  "oidc-signature",
]) {
  add(auth, "votes", {
    auth,
    status: 401,
    error: "Invalid authentication token",
  });
}
for (const kind of ["anonymous", "xid", "standard"]) {
  for (const [variant, details] of [
    ["audience", "jwt audience invalid. expected: participants"],
    ["issuer", "jwt issuer invalid. expected: https://pol.is/"],
  ]) {
    const auth = `${kind}-${variant}`;
    add(auth, "votes", {
      auth,
      status: 401,
      error: "Invalid authentication token",
      details,
    });
  }
}
add("oidc-missing-email", "votes", {
  auth: "oidc-missing-email",
  status: 400,
  error: "invalid_user_data",
});
for (const [fault, status, error] of [
  ["load", 429, "too_many_requests"],
  ["conflict", 429, "authentication_conflict"],
  ["account", 500, "user_creation_failed"],
  ["extraction", 500, "authentication_error"],
]) {
  add(`oidc-${fault}`, "votes", { auth: "oidc-refusal", fault, status, error });
}
module.exports = { cases };
