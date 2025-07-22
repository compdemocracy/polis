// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("lodash");

const oidcCacheKeyPrefix = process.env.OIDC_CACHE_KEY_PREFIX;
const oidcCacheKeyIdTokenSuffix = process.env.OIDC_CACHE_KEY_ID_TOKEN_SUFFIX;

function toNumberWithFalsyAsZero(val) {
  if (_.isUndefined(val)) {
    return 0;
  } else {
    return Number(val);
  }
}

function getUidFromUserObject() {
  var uid = window.preload && window.preload.firstUser && window.preload.firstUser.uid;
  return uid;
}

// New helper function to get conversation ID from URL
function _getConversationIdFromUrl() {
  if (window.Polis && window.Polis.conversation_id) {
    return window.Polis.conversation_id;
  }
  var pathname = window.location.pathname;
  // Based on router regexes, conversation ID is usually at the start of the path.
  var match =
    pathname.match(/^\/([0-9][0-9A-Za-z]+)/) ||
    pathname.match(/^\/conversation\/([0-9][0-9A-Za-z]+)/) ||
    pathname.match(/^\/m\/([0-9][0-9A-Za-z]+)/) ||
    pathname.match(/^\/demo\/([0-9][0-9A-Za-z]+)/);
  if (match) {
    // The conversation_id is in the last captured group.
    return match[match.length - 1];
  }
  return null;
}

// New helper to get conversation ID from a token
function _getConversationIdFromDecodedJwt(token) {
  if (!token) return null;
  try {
    var parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    var payload = JSON.parse(atob(parts[1]));
    return payload.conversation_id || null;
  } catch (e) {
    console.error("[PolisStorage] Error decoding JWT for conversation_id:", e);
    return null;
  }
}

function _getOidcTokenFromStorage(storage) {
  if (!storage) return null;

  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    // The access token is in a key that does NOT end with @@user@@
    if (key && key.startsWith(oidcCacheKeyPrefix) && !key.endsWith(oidcCacheKeyIdTokenSuffix)) {
      try {
        const value = storage.getItem(key);
        if (value) {
          const parsed = JSON.parse(value);
          // Check for expiry and access_token
          if (
            parsed &&
            parsed.body &&
            parsed.body.access_token &&
            parsed.expiresAt &&
            parsed.expiresAt > Math.floor(Date.now() / 1000)
          ) {
            return parsed.body.access_token;
          }
        }
      } catch (e) {
        // Not valid JSON or other error, continue
        console.warn("[PolisStorage] Error parsing OIDC storage key " + key, e);
      }
    }
  }
  return null;
}

function getOidcToken() {
  let token = _getOidcTokenFromStorage(window.localStorage);
  if (!token) {
    token = _getOidcTokenFromStorage(window.sessionStorage);
  }
  return token;
}

function userCreated() {
  var created =
    toNumberWithFalsyAsZero(window.preload && window.preload.firstUser && window.preload.firstUser.created) ||
    Date.now();
  return created;
}

// JWT token management functions
function getJwtToken() {
  try {
    var conversationId = _getConversationIdFromUrl();
    var token = null;
    var tokenKey = null;

    if (conversationId) {
      tokenKey = "participant_token_" + conversationId;
      token = window.localStorage
        ? window.localStorage.getItem(tokenKey)
        : window.sessionStorage
          ? window.sessionStorage.getItem(tokenKey)
          : null;
    }

    // If no participant token, check for auth token (OIDC users)
    if (!token) {
      token = getOidcToken();
    }

    if (!token) {
      return null;
    }

    // Check if token is expired
    if (isJwtTokenExpired(token)) {
      console.warn("[PolisStorage] JWT token is expired, clearing for key: ", tokenKey);
      // clear just this token
      if (tokenKey) {
        if (window.localStorage) {
          window.localStorage.removeItem(tokenKey);
        }
        if (window.sessionStorage) {
          window.sessionStorage.removeItem(tokenKey);
        }
      }
      return null;
    }

    return token;
  } catch (e) {
    console.error("[PolisStorage] Error getting JWT token:", e);
    return null;
  }
}

function setJwtToken(token) {
  try {
    if (!token) {
      console.warn("[PolisStorage] Attempted to set null/empty token");
      return;
    }

    var conversationId = _getConversationIdFromDecodedJwt(token);
    if (!conversationId) {
      console.error("[PolisStorage] No conversation_id in JWT, cannot store participant token securely.");
      return;
    }

    var tokenKey = "participant_token_" + conversationId;

    // Store as participant_token_{conversationId}
    if (window.localStorage) {
      window.localStorage.setItem(tokenKey, token);
    } else if (window.sessionStorage) {
      window.sessionStorage.setItem(tokenKey, token);
    } else {
      console.warn("[PolisStorage] No storage available for JWT token");
    }
  } catch (e) {
    console.error("[PolisStorage] Error storing JWT token:", e);
  }
}

function clearJwtToken() {
  var conversationId = _getConversationIdFromUrl();
  if (!conversationId) {
    console.warn(
      "[PolisStorage] clearJwtToken() called without a conversation_id in the URL. No participant token will be cleared."
    );
    return;
  }

  try {
    var tokenKey = "participant_token_" + conversationId;
    if (window.localStorage) {
      window.localStorage.removeItem(tokenKey);
    }
    if (window.sessionStorage) {
      window.sessionStorage.removeItem(tokenKey);
    }
  } catch (e) {
    console.error("[PolisStorage] Error clearing JWT token:", e);
  }
}

function isJwtTokenExpired(token) {
  try {
    // JWT structure: header.payload.signature
    var parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("[PolisStorage] Invalid JWT format (parts.length =", parts.length, ")");
      return true; // Invalid JWT
    }

    // Decode the payload (base64)
    var payload = JSON.parse(atob(parts[1]));

    // Check expiration
    if (payload.exp) {
      var currentTime = Math.floor(Date.now() / 1000);
      var expired = currentTime >= payload.exp;
      return expired;
    }
    return false; // No expiration, assume valid
  } catch (e) {
    console.error("[PolisStorage] Error checking JWT expiration:", e);
    return true; // Assume expired on error
  }
}

// Extract user info from JWT token
function getUidFromJwt() {
  var token = getJwtToken();
  if (!token) {
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
    return uid;
  } catch (e) {
    console.error("[PolisStorage] Error extracting uid from JWT:", e);
    return null;
  }
}

// This is the function that will be used to get the user's UID
// It will first check the JWT token, then the preload data, and return the first non-null value
function finalUid() {
  var jwtUid = getUidFromJwt();
  var preloadUid = getUidFromUserObject();
  var finalUid = jwtUid || preloadUid;
  return finalUid;
}

module.exports = {
  uid: finalUid,
  userCreated: userCreated,
  setJwtToken: setJwtToken,
  getJwtToken: getJwtToken,
  clearJwtToken: clearJwtToken
};
