// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("lodash");

function toNumberWithFalsyAsZero(val) {
  if (_.isUndefined(val)) {
    return 0;
  } else {
    return Number(val);
  }
}

function getUidFromUserObject() {
  var uid = window.preload && window.preload.firstUser && window.preload.firstUser.uid;
  console.log(
    "[PolisStorage] getUidFromUserObject:",
    uid,
    "preload.firstUser:",
    window.preload && window.preload.firstUser
  );
  return uid;
}

function userCreated() {
  var created =
    toNumberWithFalsyAsZero(window.preload && window.preload.firstUser && window.preload.firstUser.created) ||
    Date.now();
  console.log("[PolisStorage] userCreated:", created);
  return created;
}

// JWT token management functions
function getJwtToken() {
  console.log("[PolisStorage] getJwtToken() called");
  try {
    // Check for participant token first (anonymous/XID users)
    var token = window.localStorage
      ? window.localStorage.getItem("participant_token")
      : window.sessionStorage
        ? window.sessionStorage.getItem("participant_token")
        : null;
    console.log("[PolisStorage] participant_token:", token ? "present (length: " + token.length + ")" : "not found");

    // If no participant token, check for auth token (Auth0 users)
    if (!token) {
      token = window.localStorage
        ? window.localStorage.getItem("auth_token")
        : window.sessionStorage
          ? window.sessionStorage.getItem("auth_token")
          : null;
      console.log("[PolisStorage] auth_token:", token ? "present (length: " + token.length + ")" : "not found");
    }

    if (!token) {
      console.log("[PolisStorage] No JWT token found in any storage location");
      return null;
    }

    // Check if token is expired
    if (isJwtTokenExpired(token)) {
      console.log("[PolisStorage] JWT token is expired, clearing");
      clearJwtToken();
      return null;
    }

    console.log("[PolisStorage] Returning valid JWT token");
    return token;
  } catch (e) {
    console.error("[PolisStorage] Error getting JWT token:", e);
    return null;
  }
}

function setJwtToken(token) {
  console.log("[PolisStorage] setJwtToken() called with token length:", token ? token.length : "null");
  try {
    if (!token) {
      console.warn("[PolisStorage] Attempted to set null/empty token");
      return;
    }

    // Store as participant_token (primary token for anonymous/XID users)
    if (window.localStorage) {
      window.localStorage.setItem("participant_token", token);
      console.log("[PolisStorage] Token stored in localStorage");
    } else if (window.sessionStorage) {
      window.sessionStorage.setItem("participant_token", token);
      console.log("[PolisStorage] Token stored in sessionStorage");
    } else {
      console.warn("[PolisStorage] No storage available for JWT token");
    }
  } catch (e) {
    console.error("[PolisStorage] Error storing JWT token:", e);
  }
}

function clearJwtToken() {
  console.log("[PolisStorage] clearJwtToken() called");
  try {
    if (window.localStorage) {
      window.localStorage.removeItem("participant_token");
      window.localStorage.removeItem("auth_token");
      console.log("[PolisStorage] Tokens cleared from localStorage");
    }
    if (window.sessionStorage) {
      window.sessionStorage.removeItem("participant_token");
      window.sessionStorage.removeItem("auth_token");
      console.log("[PolisStorage] Tokens cleared from sessionStorage");
    }
  } catch (e) {
    console.error("[PolisStorage] Error clearing JWT token:", e);
  }
}

function isJwtTokenExpired(token) {
  console.log("[PolisStorage] Checking if JWT token is expired");
  try {
    // JWT structure: header.payload.signature
    var parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("[PolisStorage] Invalid JWT format (parts.length =", parts.length, ")");
      return true; // Invalid JWT
    }

    // Decode the payload (base64)
    var payload = JSON.parse(atob(parts[1]));
    console.log("[PolisStorage] JWT payload:", payload);

    // Check expiration
    if (payload.exp) {
      var currentTime = Math.floor(Date.now() / 1000);
      var expired = currentTime >= payload.exp;
      console.log(
        "[PolisStorage] Token expiration check - current:",
        currentTime,
        "expires:",
        payload.exp,
        "expired:",
        expired
      );
      return expired;
    }

    console.log("[PolisStorage] No expiration time in token, assuming valid");
    return false; // No expiration, assume valid
  } catch (e) {
    console.error("[PolisStorage] Error checking JWT expiration:", e);
    return true; // Assume expired on error
  }
}

// Extract user info from JWT token
function getUidFromJwt() {
  console.log("[PolisStorage] getUidFromJwt() called");
  var token = getJwtToken();
  if (!token) {
    console.log("[PolisStorage] No token available for UID extraction");
    return null;
  }

  try {
    var parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("[PolisStorage] Invalid JWT format for UID extraction");
      return null;
    }

    var payload = JSON.parse(atob(parts[1]));
    var uid = payload.uid || null;
    console.log("[PolisStorage] Extracted UID from JWT:", uid);
    return uid;
  } catch (e) {
    console.error("[PolisStorage] Error extracting uid from JWT:", e);
    return null;
  }
}

// Check if user has email (for Auth0 users, this would be in the JWT claims)
function hasEmail() {
  console.log("[PolisStorage] hasEmail() called");
  var token = getJwtToken();
  if (!token) {
    console.log("[PolisStorage] No token available for email check");
    return false;
  }

  try {
    var parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("[PolisStorage] Invalid JWT format for email check");
      return false;
    }

    var payload = JSON.parse(atob(parts[1]));
    // For Auth0 users, email would be in the token
    // For anonymous/XID users, they don't have email
    var hasEmailResult = !!(payload.email || (payload.sub && !payload.anonymous));
    console.log("[PolisStorage] Email check result:", hasEmailResult, "payload:", payload);
    return hasEmailResult;
  } catch (e) {
    console.error("[PolisStorage] Error checking email from JWT:", e);
    return false;
  }
}

module.exports = {
  hasEmail: hasEmail,
  uid: function () {
    console.log("[PolisStorage] uid() called");
    // Try JWT first, then fallback to preload data
    var jwtUid = getUidFromJwt();
    var preloadUid = getUidFromUserObject();
    var finalUid = jwtUid || preloadUid;
    console.log("[PolisStorage] uid() returning:", finalUid, "(jwt:", jwtUid, "preload:", preloadUid, ")");
    return finalUid;
  },
  userCreated: userCreated,
  // JWT token management
  setJwtToken: setJwtToken,
  getJwtToken: getJwtToken,
  clearJwtToken: clearJwtToken
};
