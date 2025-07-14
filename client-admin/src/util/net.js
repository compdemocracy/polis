// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from './url'

const urlPrefix = URLs.urlPrefix
const basePath = ''

// Auth0 token getter function - this should be set by the app when Auth0 is initialized
let getAuth0AccessToken = null

// Function to set the Auth0 token getter from the Auth0 context
export const setAuth0TokenGetter = (tokenGetter) => {
  getAuth0AccessToken = tokenGetter
}

// Store Auth0 hooks for login redirect
let auth0LoginRedirect = null

export const setAuth0Actions = (loginWithRedirect) => {
  auth0LoginRedirect = loginWithRedirect
}

const getAccessTokenSilentlySPA = async (options) => {
  if (getAuth0AccessToken) {
    try {
      return await getAuth0AccessToken({
        cacheMode: 'on', // Use cached token if valid
        ...options
      })
    } catch (e) {
      console.error('Error getting Auth0 token:', e)
      
      // Handle specific Auth0 errors
      if (e.error === 'login_required' && auth0LoginRedirect) {
        console.warn('Login required, redirecting to Auth0')
        auth0LoginRedirect()
        return null
      }
      
      // Let the error bubble up to be handled by the calling code
      throw e
    }
  } else {
    return Promise.resolve(undefined)
  }
}

// Request interceptor for handling auth errors
const handleAuthError = (error, response) => {
  if (response && (response.status === 401 || response.status === 403)) {
    console.warn('Authentication/authorization error:', response.status)
    
    // For 401 (unauthorized), try to redirect to login
    if (response.status === 401 && auth0LoginRedirect) {
      console.warn('Token expired or invalid, redirecting to login')
      setTimeout(() => {
        auth0LoginRedirect()
      }, 1000) // Small delay to allow error handling to complete
    }
  }
  
  throw error
}

async function polisFetch(api, data, type) {
  if (typeof api !== 'string') {
    throw new Error('api param should be a string');
  }

  if (api && api.length && api[0] === '/') {
    api = api.slice(1);
  }

  let url = urlPrefix + basePath + api;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'max-age=0',
  };

  let body = null;
  let method = type ? type.toUpperCase() : 'GET';

  if (method === 'GET' && data) {
    const queryParams = new URLSearchParams(data);
    url += `?${queryParams.toString()}`;
  } else if (method === 'POST' && data) {
    body = JSON.stringify(data);
  }
  
  try {
    const token = await getAccessTokenSilentlySPA();
    
    // Only add the header if a token exists
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      console.warn('⚠️ No token available - request will be sent without auth');
    }
  } catch (error) {
    console.error('❌ Error getting access token:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    // Re-throw the error to be caught by the caller
    throw error;
  }

  try {
    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
    });

    if (!response.ok && response.status !== 304) {
      // Read the response body to include in the error
      const errorBody = await response.text();
      console.error('❌ API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody
      });
      
      // Create a new error object and attach the response body
      const error = new Error(`Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`);
      error.responseText = errorBody;
      error.status = response.status;

      return handleAuthError(error, response);
    }

    const jsonResponse = await response.json();
    return jsonResponse;
  } catch (error) {
    console.error('❌ polisFetch error:', error);
    throw error;
  }
}

async function polisPost(api, data) {
  return await polisFetch(api, data, 'POST')
}

async function polisGet(api, data) {
  try {
    const d = await polisFetch(api, data, 'GET')
    return d
  } catch (error) {
    // If we have a 403, it might be the initial race condition. Retry once.
    if (error.status === 403) {
      console.warn('⚠️ Received 403 on GET, retrying request once after a short delay...');
      await new Promise(resolve => setTimeout(resolve, 500)); // wait 500ms
      return await polisFetch(api, data, 'GET'); // This is the retry
    }
    // For other errors, or if retry fails, log and re-throw.
    console.error('❌ polisGet error:', error)
    throw error;
  }
}

const PolisNet = {
  polisFetch: polisFetch,
  polisPost: polisPost,
  polisGet: polisGet,
  getAccessTokenSilentlySPA
}
export default PolisNet
