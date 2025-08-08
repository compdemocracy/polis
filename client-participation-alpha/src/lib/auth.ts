/**
 * Decodes a JWT from localStorage without verifying its signature.
 *
 * @param {string} key The localStorage key where the JWT is stored.
 * @returns {object|null} The decoded JWT payload as an object, or null if the token is not found or invalid.
 */
export function getJwtPayload(key: string) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const jwt = localStorage.getItem(key);

    if (!jwt) {
      return null;
    }
    const payloadBase64 = jwt.split('.')[1];
    if (!payloadBase64) {
      return null;
    }

    const jsonPayload = atob(payloadBase64);
    return JSON.parse(jsonPayload);

  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
}

export function getConversationToken(conversation_id: string) {
  const token = getJwtPayload(`participant_token_${conversation_id}`);
  if (!token) {
    return getOidcToken();
  }
  return token;
}

const oidcCacheKeyPrefix = import.meta.env.PUBLIC_OIDC_CACHE_KEY_PREFIX;
const oidcCacheKeyIdTokenSuffix = import.meta.env.PUBLIC_OIDC_CACHE_KEY_ID_TOKEN_SUFFIX;

export function setJwtToken(token: string) {
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

function _getConversationIdFromDecodedJwt(token: string) {
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

function _getOidcTokenFromStorage(storage: Storage) {
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
            parsed?.access_token &&
            parsed?.expires_at > Math.floor(Date.now() / 1000)
          ) {
            return parsed.access_token;
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

export function getOidcToken() {
  let token = _getOidcTokenFromStorage(window.localStorage);
  if (!token) {
    token = _getOidcTokenFromStorage(window.sessionStorage);
  }
  return token;
}
