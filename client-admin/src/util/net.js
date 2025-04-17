// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from './url'
import * as auth0 from '@auth0/auth0-spa-js'
import _ from 'lodash'

const urlPrefix = URLs.urlPrefix
const basePath = ''

// var pid = "unknownpid";

let auth0Client = null

const getAccessTokenSilentlySPA = async (options) => {
  if (process.env.USE_AUTH_PROVIDER) {
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

  if (process.env.USE_AUTH_PROVIDER) {
    try {
      const token = await getAccessTokenSilentlySPA({
        audience: 'users',
        scope: 'openid,profile,email',
      });
      headers.Authorization = `Bearer ${token}`;
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
      // Log the error details for debugging
      console.error('polisFetch failed:', response.status, response.statusText, await response.text());
      if (response.status === 403) {
        // Handle 403 Forbidden specifically if needed
        // eb.trigger(eb.authNeeded);
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const jsonResponse = await response.json();
    return jsonResponse;
  } catch (error) {
    console.error('polisFetch error:', error);
    // Optionally re-throw the error or return a specific error object/promise
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
