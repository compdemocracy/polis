const oidcCacheKeyPrefix = import.meta.env.PUBLIC_OIDC_CACHE_KEY_PREFIX;
const oidcCacheKeyIdTokenSuffix = import.meta.env.PUBLIC_OIDC_CACHE_KEY_ID_TOKEN_SUFFIX;

/**
 * Helper function to get conversation ID from current URL path
 * Handles URLs like /alpha/2demo or just /2demo
 */
export function getConversationIdFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const pathname = window.location.pathname;
  // Match patterns like /alpha/2demo or just /2demo
  // Conversation IDs start with a digit followed by alphanumeric chars
  const match = pathname.match(/^\/(?:alpha\/)?([0-9][0-9A-Za-z]+)/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Get XID from URL query parameters
 */
export function getXidFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const params = new URLSearchParams(window.location.search);
  return params.get('xid');
}

/**
 * Get x_name from URL query parameters
 */
export function getXNameFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const params = new URLSearchParams(window.location.search);
  return params.get('x_name');
}

/**
 * Get x_profile_image_url from URL query parameters
 */
export function getXProfileImageUrlFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const params = new URLSearchParams(window.location.search);
  return params.get('x_profile_image_url');
}

/**
 * Check if user is authenticated via OIDC
 * Returns true if any valid OIDC token exists (access_token or id_token)
 */
export function isOidcAuthenticated(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const checkStorage = (storage: Storage | null): boolean => {
    if (!storage) return false;
    
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(oidcCacheKeyPrefix)) {
        try {
          const value = storage.getItem(key);
          if (value) {
            const parsed = JSON.parse(value);
            // Check for any valid token (access_token or id_token) that hasn't expired
            if (parsed && (parsed.access_token || parsed.id_token)) {
              // Check expiry if present
              if (parsed.expires_at && parsed.expires_at <= Math.floor(Date.now() / 1000)) {
                continue; // Token expired, keep looking
              }
              return true;
            }
          }
        } catch (e) {
          // Not valid JSON or other error, continue
        }
      }
    }
    return false;
  };

  return checkStorage(window.localStorage) || checkStorage(window.sessionStorage);
}

/**
 * Decodes a JWT from localStorage without verifying its signature.
 *
 * @param {string} key The localStorage key where the JWT is stored.
 * @returns {object|null} The decoded JWT payload as an object, or null if the token is not found or invalid.
 */
function _getJwtPayload(key: string) {
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
  if (typeof window === 'undefined') {
    return null;
  }
  const tokenKey = `participant_token_${conversation_id}`;
  const rawToken = localStorage.getItem(tokenKey);
  
  if (!rawToken) {
    // No conversation-specific token, try OIDC
    const oidcToken = _getOidcToken();
    if (oidcToken) {
      return { token: oidcToken };
    }
    return null;
  }
  
  // Decode the JWT to get the payload
  const payload = _getJwtPayload(tokenKey);
  if (!payload) {
    return null;
  }
  
  return {
    token: rawToken,
    ...payload
  };
}

export function setJwtToken(token: string) {
  if (typeof window === 'undefined') {
    return;
  }
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

export function _getOidcTokenFromStorage(storage: Storage) {
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

function _getOidcToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return _getOidcTokenFromStorage(window.localStorage);
}

/**
 * Automatically extract and store JWT token from API response
 * This should be called by the net module for all API responses
 */
export function handleJwtFromResponse(response: any): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (response && response.auth && response.auth.token) {
    console.log("[Auth] JWT token found in response, storing...");
    setJwtToken(response.auth.token);
  }
}
