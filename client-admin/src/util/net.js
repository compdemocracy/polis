// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from './url'
import * as auth0 from '@auth0/auth0-spa-js'

const urlPrefix = URLs.urlPrefix
const basePath = ''

// var pid = "unknownpid";

let auth0Client = null

const getAccessTokenSilentlySPA = async (options) => {
  console.log('getAccessTokenSilentlySPA', process.env.AUTH_CLIENT_ID, !!process.env.AUTH_CLIENT_ID)
  if (process.env.AUTH_CLIENT_ID) {
    try {
      const initializeAuth0 = async () => {
        auth0Client = await auth0.createAuth0Client({
          domain: 'compdem.us.auth0.com',
          clientId: process.env.AUTH_CLIENT_ID,
          authorizationParams: {
            audience: 'users'
          }
        })
      }
      if (!auth0Client) {
        await initializeAuth0()
        // return Promise.resolve(undefined)
      }
      return await auth0Client.getTokenSilently(options)
    } catch (e) {
      console.log(e)
      auth0Client.loginWithRedirect()
    }
  } else {
    return Promise.resolve(undefined)
  }
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

  const credentials = 'include'; // Equivalent to xhrFields: { withCredentials: true }

  let body = null;
  let method = type ? type.toUpperCase() : 'GET';

  if (method === 'GET' && data) {
    const queryParams = new URLSearchParams(data);
    url += `?${queryParams.toString()}`;
  } else if (method === 'POST' && data) {
    body = JSON.stringify(data);
  }

  if (process.env.AUTH_CLIENT_ID) {
    try {
      const token = await getAccessTokenSilentlySPA({
        audience: 'users',
        scope: 'openid,profile,email',
      });
      // Only add the header if a token exists
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error('Error getting access token:', error);
      // Handle the error appropriately, e.g., redirect to login
      // You might want to return a rejected promise here as well
      // to signal the failure of the API call due to auth issues.
      throw error; // Re-throw the error to be caught by the caller
    }
  }

  try {
    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: credentials,
    });

    if (!response.ok) {
      // Read the response body to include in the error
      const errorBody = await response.text();
      // Create a new error object and attach the response body
      const error = new Error(`Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`);
      error.responseText = errorBody;
      error.status = response.status;

      throw error;
    }

    const jsonResponse = await response.json();
    return jsonResponse;
  } catch (error) {
    console.error('polisFetch error:', error);
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
    console.log(error)
  }
}

const PolisNet = {
  polisFetch: polisFetch,
  polisPost: polisPost,
  polisGet: polisGet,
  getAccessTokenSilentlySPA
}
export default PolisNet
