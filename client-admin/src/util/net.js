// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from './url'

const urlPrefix = URLs.urlPrefix
const basePath = ''

// Auth/OIDC token getter function - this should be set by the app when Auth is initialized
let getOidcAccessToken = null

let authReady = false
let authReadyPromise = null
let authReadyResolve = null

// Create a promise that resolves when auth is ready
const initAuthReadyPromise = () => {
  authReadyPromise = new Promise((resolve) => {
    authReadyResolve = resolve
  })
}

// Initialize the promise immediately
initAuthReadyPromise()

export const setOidcTokenGetter = (getter) => {
  getOidcAccessToken = getter

  if (getter) {
    // Auth is now ready
    authReady = true
    if (authReadyResolve) {
      authReadyResolve()
    }
  } else {
    // Auth is being cleared, reset the ready state
    authReady = false
    initAuthReadyPromise()
  }
}

// Store Auth hooks for login redirect
let oidcLoginRedirect = null

export const setOidcActions = (actions) => {
  if (actions && typeof actions === 'object') {
    oidcLoginRedirect = actions.signinRedirect
  } else {
    // Clear if null/undefined passed
    oidcLoginRedirect = null
  }
}

// Export functions to check auth readiness
export const isAuthReady = () => authReady
export const waitForAuthReady = () => authReadyPromise

const getAccessTokenSilentlySPA = async (options) => {
  // Wait for auth to be ready
  if (!authReady && authReadyPromise) {
    await authReadyPromise
  }

  if (getOidcAccessToken) {
    try {
      const token = await getOidcAccessToken({
        cacheMode: 'on', // Use cached token if valid
        ...options
      })
      return token
    } catch (e) {
      // Handle specific OIDC errors
      if (
        e.error === 'login_required' &&
        oidcLoginRedirect &&
        typeof oidcLoginRedirect === 'function'
      ) {
        oidcLoginRedirect()
        return null
      }

      // Let the error bubble up to be handled by the calling code
      throw e
    }
  } else {
    console.warn('⚠️ Token getter not available even after waiting')
    return Promise.resolve(undefined)
  }
}

// Request interceptor for handling auth errors
const handleAuthError = (error, response) => {
  if (response && (response.status === 401 || response.status === 403)) {
    console.warn('Authentication/authorization error:', response.status)
    // For 401 (unauthorized), try to redirect to login
    if (response.status === 401) {
      // Check if we should force signout
      if (oidcLoginRedirect && typeof oidcLoginRedirect === 'function') {
        oidcLoginRedirect()
        return error
      }
    }
  }

  throw error
}

async function polisFetch(api, data, type) {
  if (typeof api !== 'string') {
    throw new Error('api param should be a string')
  }

  if (api && api.length && api[0] === '/') {
    api = api.slice(1)
  }

  let url = urlPrefix + basePath + api

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'max-age=0'
  }

  let body = null
  let method = type ? type.toUpperCase() : 'GET'

  if (method === 'GET' && data && Object.keys(data).length > 0) {
    const queryParams = new URLSearchParams(data)
    url += `?${queryParams.toString()}`
  } else if ((method === 'POST' || method === 'PUT') && data && Object.keys(data).length > 0) {
    body = JSON.stringify(data)
  }

  try {
    const token = await getAccessTokenSilentlySPA()

    // Only add the header if a token exists
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
  } catch (error) {
    // If getting the token fails, continue without it
    // The server will decide if auth is required
    console.warn('⚠️ Error getting access token:', error)
  }

  const response = await fetch(url, {
    method: method,
    headers: headers,
    body: body
  })

  if (!response.ok && response.status !== 304) {
    // Read the response body to include in the error
    const errorBody = await response.text()
    console.error('❌ API Error Response:', {
      status: response.status,
      statusText: response.statusText,
      body: errorBody
    })

    // Create a new error object and attach the response body
    const error = new Error(
      `Polis API Error: ${method} ${url} failed with status ${response.status} (${response.statusText})`
    )
    error.responseText = errorBody
    error.status = response.status

    return handleAuthError(error, response)
  }

  const jsonResponse = await response.json()
  return jsonResponse
}

async function polisPost(api, data) {
  return await polisFetch(api, data, 'POST')
}

async function polisPut(api, data) {
  return await polisFetch(api, data, 'PUT')
}

async function polisGet(api, data) {
  try {
    const d = await polisFetch(api, data, 'GET')
    return d
  } catch (error) {
    // If we have a 403, it might be the initial race condition. Retry once.
    if (error.status === 403) {
      console.warn('⚠️ Received 403 on GET, retrying request once after a short delay...')
      await new Promise((resolve) => setTimeout(resolve, 500)) // wait 500ms
      return await polisFetch(api, data, 'GET') // This is the retry
    }
    // For other errors, or if retry fails, log and re-throw.
    console.error('❌ polisGet error:', error)
    throw error
  }
}

const PolisNet = {
  polisFetch: polisFetch,
  polisPost: polisPost,
  polisPut: polisPut,
  polisGet: polisGet,
  getAccessTokenSilentlySPA
}
export default PolisNet
