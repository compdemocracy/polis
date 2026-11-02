"use strict";
const cases = [];
const add = (name, route, options = {}) =>
  cases.push({
    name,
    route,
    method: "GET",
    auth: "owner",
    status: 200,
    ...options,
  });
const accept = (name, options = {}) =>
  add(name, "acceptInvite", {
    method: "POST",
    auth: null,
    status: 201,
    ...options,
  });
const login = (name, options = {}) =>
  add(name, "login", {
    method: "POST",
    auth: null,
    credential: "accept-fresh",
    ...options,
  });
add("waves-empty", "waves");
add("invites-empty", "invites");
add("owner-csv-empty", "invites/csv");
for (const route of ["me", "myInvites", "myInvites/csv"]) {
  add(`nonmember-${route.replaceAll("/", "-")}`, route, {
    auth: "standard-nonmember",
  });
  add(`member-empty-${route.replaceAll("/", "-")}`, route, {
    auth: "participant",
  });
}
add("wave-root", "waves", {
  method: "POST",
  status: 201,
  data: { parent_wave: 0, owner_invites: 12, invites_per_user: 1 },
});
add("wave-child-before-accept", "waves", {
  method: "POST",
  status: 201,
  data: { parent_wave: 1, owner_invites: 0, invites_per_user: 2 },
});
add("waves-list", "waves");
add("waves-filter", "waves", { data: { wave: 1 } });
add("invites-list", "invites");
add("invites-pagination", "invites", {
  data: { limit: 2, offset: 1, status: 0, wave_id: 1 },
});
add("invites-pagination-clamps", "invites", {
  data: { limit: 999, offset: -1 },
});
add("owner-csv-populated", "invites/csv");
accept("accept-fresh", { invite: 0, users: 1, participants: 1, children: 2 });
login("login-round-trip");
add("me-round-trip", "me", { auth: "login-round-trip" });
add("my-invites-populated", "myInvites", { auth: "accept-fresh" });
add("my-csv-populated", "myInvites/csv", { auth: "accept-fresh" });
accept("accept-child", { childOf: "accept-fresh", users: 1, participants: 1 });
add("me-includes-used-child", "me", { auth: "accept-fresh" });
add("my-invites-unused-only", "myInvites", { auth: "accept-fresh" });
add("my-csv-unused-only", "myInvites/csv", { auth: "accept-fresh" });
add("wave-child-after-accept", "waves", {
  method: "POST",
  status: 201,
  data: { parent_wave: 1, owner_invites: 0, invites_per_user: 1 },
});
add("wave-default-parent", "waves", {
  method: "POST",
  status: 201,
  data: { owner_invites: 1 },
});
accept("accept-used", {
  invite: 0,
  status: 400,
  error: "polis_err_treevite_invalid_or_used_invite",
});
accept("accept-unknown", {
  code: "generated-unknown",
  status: 400,
  error: "polis_err_treevite_invalid_or_used_invite",
});
accept("accept-wrong-conversation", {
  invite: 1,
  zid: 2,
  status: 400,
  error: "polis_err_treevite_invalid_or_used_invite",
});
for (const [label, value] of [
  ["revoked", 2],
  ["expired-status", 3],
])
  accept(`accept-${label}`, {
    invite: 1,
    inviteStatus: value,
    status: 400,
    error: "polis_err_treevite_invalid_or_used_invite",
  });
accept("accept-disabled-current-success", {
  invite: 2,
  disabled: true,
  users: 1,
  participants: 1,
  children: 3,
});
login("login-disabled-current-success", {
  credential: "accept-disabled-current-success",
  disabled: true,
});
add("wave-disabled-current-success", "waves", {
  method: "POST",
  status: 201,
  disabled: true,
  data: { parent_wave: 0, owner_invites: 1 },
});
accept("accept-existing-xid-conversion", {
  auth: "xid",
  invite: 3,
  allowlist: true,
  children: 3,
  delta: "TQ1",
});
login("login-converted-xid", {
  credential: "accept-existing-xid-conversion",
  allowlist: true,
  removeAllowed: true,
  delta: "TQ1",
});
add("original-xid-removed-refused", "me", {
  auth: "xid",
  allowlist: true,
  removeAllowed: true,
  status: 403,
  error: "polis_err_xid_not_allowed",
});
add("converted-anonymous-after-removal", "me", {
  auth: "login-converted-xid",
  allowlist: true,
  removeAllowed: true,
  delta: "TQ1",
});
accept("allowlisted-bare-xid-invite", {
  invite: 4,
  allowlist: true,
  data: { xid: "generated-member" },
  users: 1,
  participants: 1,
  children: 3,
});
accept("accept-standard-conversion", {
  auth: "standard",
  invite: 5,
  children: 0,
  delta: "TQ1",
});
accept("accept-pid-zero-forks", {
  auth: "pid0",
  invite: 6,
  users: 1,
  participants: 1,
  children: 3,
  delta: "Q14",
});
accept("accept-anonymous-other-conversation", {
  auth: "accept-fresh",
  invite: 7,
  zid: 2,
  seedTarget: true,
  participants: 1,
  delta: "Q14",
});
accept("accept-trimmed", {
  invite: 8,
  trim: true,
  users: 1,
  participants: 1,
  children: 3,
});
login("login-trimmed", { credential: "accept-trimmed", trim: true });
login("login-unknown", {
  code: "generated-unknown",
  status: 401,
  error: "polis_err_treevite_login_code_invalid",
});
login("login-wrong-conversation", {
  zid: 2,
  status: 401,
  error: "polis_err_treevite_login_code_invalid",
});
login("login-revoked", {
  revoke: true,
  status: 401,
  error: "polis_err_treevite_login_code_invalid",
});
login("login-expiry-ignored", { expired: true });
login("login-hash-mismatch", {
  mismatch: true,
  status: 401,
  error: "polis_err_treevite_login_code_invalid",
});
for (const [route, key, max] of [
  ["acceptInvite", "invite_code", 128],
  ["login", "login_code", 256],
]) {
  for (const [label, value] of [
    ["missing", undefined],
    ["empty", ""],
    ["oversized", "x".repeat(max + 1)],
    ["whitespace", " \t "],
  ])
    add(`${route}-${label}`, route, {
      method: "POST",
      auth: null,
      status: 400,
      data: { [key]: value },
      error:
        label === "whitespace"
          ? "polis_err_treevite_invalid_request"
          : undefined,
    });
}
add("wave-nonowner", "waves", {
  method: "POST",
  auth: "participant",
  status: 403,
  data: { owner_invites: 1 },
  error: "polis_err_treevite_not_conversation_owner",
});
add("wave-zero-counts", "waves", {
  method: "POST",
  status: 400,
  data: { owner_invites: 0, invites_per_user: 0 },
  error: "polis_err_treevite_wave_requires_invites",
});
add("wave-negative-counts", "waves", {
  method: "POST",
  status: 400,
  data: { owner_invites: -1 },
  error: "polis_err_treevite_wave_requires_invites",
});
add("wave-parent-missing", "waves", {
  method: "POST",
  status: 400,
  data: { owner_invites: 1, parent_wave: 999 },
  error: "polis_err_treevite_parent_wave_not_found",
});
add("wave-invalid-integer", "waves", {
  method: "POST",
  status: 400,
  data: { owner_invites: "no" },
});
for (const route of ["waves", "invites", "invites/csv"])
  add(`nonowner-${route.replaceAll("/", "-")}`, route, {
    auth: "participant",
    status: 403,
    error: "polis_err_treevite_not_conversation_owner",
  });
for (const [method, route] of [
  ["POST", "waves"],
  ["GET", "waves"],
  ["GET", "invites"],
  ["GET", "invites/csv"],
  ["POST", "acceptInvite"],
  ["POST", "login"],
  ["GET", "me"],
  ["GET", "myInvites"],
  ["GET", "myInvites/csv"],
]) {
  const label = `${method}-${route.replaceAll("/", "-")}`;
  add(`bad-bearer-${label}`, route, {
    method,
    auth: "bad",
    status: 401,
    error: "Invalid token format",
  });
  add(`missing-conversation-${label}`, route, {
    method,
    missingConversation: true,
    status: 400,
  });
  if (!["acceptInvite", "login"].includes(route))
    add(`no-bearer-${label}`, route, {
      method,
      auth: null,
      status: 401,
      error: "No authentication token found",
    });
  if (method === "GET")
    add(`head-${label}`, route, {
      method: "HEAD",
      auth: ["me", "myInvites", "myInvites/csv"].includes(route)
        ? "accept-fresh"
        : "owner",
    });
}
accept("race-two-accepts", {
  invite: 9,
  race: true,
  users: 2,
  participants: 2,
  children: 3,
  delta: "F2",
});
add("owner-invites-final", "invites");
add("owner-csv-final", "invites/csv");
module.exports = { cases };
