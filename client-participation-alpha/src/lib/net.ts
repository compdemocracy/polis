import { handleJwtFromResponse, getConversationToken, getConversationIdFromUrl } from './auth';

// Simplified service base resolution (both env vars are required)
const SERVICE_BASE: string = (
  typeof window !== 'undefined'
    ? import.meta.env.PUBLIC_SERVICE_URL
    : import.meta.env.INTERNAL_SERVICE_URL
  )?.replace(/\/$/, '') || '';

// Default request timeout (ms)
const REQUEST_TIMEOUT_MS: number = Number(import.meta.env.PUBLIC_REQUEST_TIMEOUT_MS) || 10000;

// Optional base path (kept for compatibility; ensure it is normalized when used)
const basePath: string = '';

// Type definitions
type OidcTokenGetter = (options?: { cacheMode?: string }) => Promise<string | null>;
type OidcLoginRedirect = () => void;

interface PolisApiError extends Error {
  responseText?: string;
  status?: number;
}

// Auth/OIDC token getter function - this should be set by the app when Auth is initialized
let getOidcAccessToken: OidcTokenGetter | null = null;

let authReady = false;
let authReadyPromise: Promise<void> | null = null;
let authReadyResolve: ((value: void) => void) | null = null;

// Create a promise that resolves when auth is ready
const initAuthReadyPromise = () => {
  authReadyPromise = new Promise((resolve) => {
    authReadyResolve = resolve;
  });
}

// Initialize the promise immediately
initAuthReadyPromise();

export const setOidcTokenGetter = (getter: OidcTokenGetter | null) => {
  getOidcAccessToken = getter;

  if (getter) {
    // Auth is now ready
    authReady = true;
    if (authReadyResolve) {
      authReadyResolve();
    }
  } else {
    // Auth is being cleared, reset the ready state
    authReady = false;
    initAuthReadyPromise();
  }
};

// Store Auth hooks for login redirect
let oidcLoginRedirect: OidcLoginRedirect | null = null;

interface OidcActions {
  signinRedirect?: OidcLoginRedirect;
}

export const setOidcActions = (actions: OidcActions | null) => {
  if (actions && typeof actions === 'object') {
    oidcLoginRedirect = actions.signinRedirect || null;
  } else {
    // Clear if null/undefined passed
    oidcLoginRedirect = null;
  }
};

// Export functions to check auth readiness
export const isAuthReady = () => authReady;
export const waitForAuthReady = () => authReadyPromise;

const getAccessTokenSilentlySPA = async (options?: { cacheMode?: string }): Promise<string | null | undefined> => {
  // On the server, skip OIDC entirely
  if (typeof window === 'undefined') {
    return undefined;
  }

  // If no getter is registered, skip immediately (do not wait)
  if (!getOidcAccessToken) {
    return undefined;
  }

  // Wait for auth to be ready
  if (!authReady && authReadyPromise) {
    await authReadyPromise;
  }

  if (getOidcAccessToken) {
    try {
      const token = await getOidcAccessToken({
        cacheMode: 'on', // Use cached token if valid
        ...options
      });
      return token;
    } catch (e: any) {
      // Handle specific OIDC errors
      if (
        e.error === 'login_required' &&
        oidcLoginRedirect &&
        typeof oidcLoginRedirect === 'function'
      ) {
        oidcLoginRedirect();
        return null;
      }

      // Let the error bubble up to be handled by the calling code
      throw e;
    }
  } else {
    console.warn('⚠️ Token getter not available even after waiting');
    return Promise.resolve(undefined);
  }
};

// Request interceptor for handling auth errors
const handleAuthError = (error: PolisApiError, response: Response): PolisApiError => {
  if (response && (response.status === 401 || response.status === 403)) {
    console.warn('Authentication/authorization error:', response.status);
    // For 401 (unauthorized), try to redirect to login
    if (response.status === 401) {
      // Check if we should force signout
      if (oidcLoginRedirect && typeof oidcLoginRedirect === 'function') {
        oidcLoginRedirect();
        return error;
      }
    }
  }

  throw error;
};

async function polisFetch<T = any>(
  api: string, 
  data?: Record<string, any>, 
  type?: string
): Promise<T> {
  if (typeof api !== 'string') {
    throw new Error('api param should be a string');
  }

  // Build URL: allow absolute URLs; otherwise construct from origin/basePath and api path
  let url: string;
  const isAbsolute = /^(https?:)?\/\//i.test(api);
  if (isAbsolute) {
    url = api;
  } else {
    const apiPath = api.startsWith('/') ? api : `/${api}`;
    url = `${SERVICE_BASE}${apiPath}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'max-age=0'
  };

  let body: string | null = null;
  let method = type ? type.toUpperCase() : 'GET';

  if (method === 'GET' && data && Object.keys(data).length > 0) {
    const queryParams = new URLSearchParams(data);
    url += `?${queryParams.toString()}`
  } else if ((method === 'POST' || method === 'PUT') && data && Object.keys(data).length > 0) {
    body = JSON.stringify(data);
  }

  try {
    // First try OIDC token
    const oidcToken = await getAccessTokenSilentlySPA();
    if (oidcToken) {
      headers.Authorization = `Bearer ${oidcToken}`;
    } else {
      // Fall back to conversation-specific JWT if available
      // Extract conversation_id from data or current URL path
      let conversationId: string | null = null;
      
      // First check if conversation_id is in the request data
      if (data && (data as any).conversation_id) {
        conversationId = (data as any).conversation_id;
      } else if (typeof window !== 'undefined') {
        // Try to extract from current page URL path using shared helper
        conversationId = getConversationIdFromUrl();
      }
      
      if (conversationId) {
        const conversationToken = getConversationToken(conversationId);
        if (conversationToken && conversationToken.token) {
          headers.Authorization = `Bearer ${conversationToken.token}`;
        }
      }
    }
  } catch (error) {
    // If getting the token fails, continue without it
    // The server will decide if auth is required
    console.warn('⚠️ Error getting access token:', error);
  }

  console.log('🔍 Requesting:', {
    url,
    method,
    headers,
    body
  });

  // Add timeout to avoid indefinite hangs (especially during SSR)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      const error: PolisApiError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${url}`);
      (error as any).status = 408;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok && response.status !== 304) {
    // Read the response body to include in the error
    const errorBody = await response.text()
    console.error('❌ API Error Response:', {
      status: response.status,
      statusText: response.statusText,
      body: errorBody
    });

    // Create a new error object and attach the response body
    const error: PolisApiError = new Error(
      `Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`
    );
    error.responseText = errorBody;
    error.status = response.status;

    // handleAuthError will throw, so this never returns normally
    handleAuthError(error, response);
    throw error; // TypeScript needs this for type checking even though it's unreachable
  }

  const jsonResponse = await response.json();
  
  // Automatically handle JWT tokens in response
  handleJwtFromResponse(jsonResponse);
  
  return jsonResponse;
}

async function polisPost<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  return await polisFetch<T>(api, data, 'POST');
}

async function polisPut<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  return await polisFetch<T>(api, data, 'PUT');
}

async function polisGet<T = any>(api: string, data?: Record<string, any>): Promise<T> {
  try {
    const d = await polisFetch<T>(api, data, 'GET');
    return d;
  } catch (error: any) {
    // If we have a 403, it might be the initial race condition. Retry once.
    if (error.status === 403) {
      console.warn('⚠️ Received 403 on GET, retrying request once after a short delay...');
      await new Promise((resolve) => setTimeout(resolve, 500)); // wait 500ms
      return await polisFetch<T>(api, data, 'GET'); // This is the retry
    }
    // For other errors, or if retry fails, log and re-throw.
    console.error('❌ polisGet error:', error);
    throw error;
  }
}

// Download a CSV (or other blob) while including the correct Authorization header
async function downloadCsv(
  api: string,
  data?: Record<string, any>,
  filename?: string
): Promise<void> {
  if (typeof api !== 'string') {
    throw new Error('api param should be a string');
  }

  // Build URL
  let url: string;
  const isAbsolute = /^(https?:)?\/\//i.test(api);
  if (isAbsolute) {
    url = api;
  } else {
    const apiPath = api.startsWith('/') ? api : `/${api}`;
    url = `${SERVICE_BASE}${apiPath}`;
  }

  const method = 'GET';
  if (data && Object.keys(data).length > 0) {
    const queryParams = new URLSearchParams(data);
    url += `?${queryParams.toString()}`
  }

  const headers: Record<string, string> = {
    'Accept': 'text/csv'
  };

  // Authorization: prefer OIDC access token, fall back to conversation JWT
  try {
    const oidcToken = await getAccessTokenSilentlySPA();
    if (oidcToken) {
      headers.Authorization = `Bearer ${oidcToken}`;
    } else {
      let conversationId: string | null = null;
      if (data && (data as any).conversation_id) {
        conversationId = (data as any).conversation_id;
      } else if (typeof window !== 'undefined') {
        conversationId = getConversationIdFromUrl();
      }
      if (conversationId) {
        const conversationToken = getConversationToken(conversationId);
        if (conversationToken && conversationToken.token) {
          headers.Authorization = `Bearer ${conversationToken.token}`;
        }
      }
    }
  } catch (error) {
    console.warn('⚠️ Error getting access token for CSV download:', error);
  }

  // Timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal: controller.signal
    });
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      const error: PolisApiError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${url}`);
      (error as any).status = 408;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const error: PolisApiError = new Error(`Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`);
    error.responseText = errorText;
    error.status = response.status;
    handleAuthError(error, response);
    throw error;
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const convId = (data && (data as any).conversation_id) || (typeof window !== 'undefined' ? getConversationIdFromUrl() : '') || '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = downloadUrl;
  a.download = filename || `my_treevite_invites_${convId}_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
}

const PolisNet = {
  polisFetch: polisFetch,
  polisPost: polisPost,
  polisPut: polisPut,
  polisGet: polisGet,
  getAccessTokenSilentlySPA,
  downloadCsv
}
export default PolisNet
