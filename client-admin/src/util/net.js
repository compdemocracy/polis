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
      }
      return await auth0Client.getTokenSilently(options)
    } catch (e) {
      console.log(e)
      auth0Client.logInWithRedirect()
    }
  } else {
    return Promise.resolve(undefined)
  }
}

async function polisAjax(api, data, type) {
  if (!_.isString(api)) {
    throw new Error('api param should be a string')
  }

  if (api && api.length && api[0] === '/') {
    api = api.slice(1)
  }

  const url = urlPrefix + basePath + api

  // Add the auth token if needed.
  // if (_.contains(authenticatedCalls, api)) {
  //     var token = tokenStore.get();
  //     if (!token) {
  //         needAuthCallbacks.fire();
  //         console.error("auth needed");
  //         return $.Deferred().reject("auth needed");
  //     }
  //     //data = $.extend({ token: token}, data); // moving to cookies
  // }

  if (process.env.USE_AUTH_PROVIDER) {
    const token = await getAccessTokenSilentlySPA({
      audience: 'users',
      scope: 'openid,profile,email'
    })

    let promise
    const config = {
      url: url,
      contentType: 'application/json; charset=utf-8',
      headers: {
        // "Cache-Control": "no-cache"  // no-cache
        'Cache-Control': 'max-age=0',
        Authorization: `Bearer ${token}`
      },
      xhrFields: {
        withCredentials: true
      },
      // crossDomain: true,
      dataType: 'json'
    }
    if (type === 'GET') {
      promise = $.ajax(
        $.extend(config, {
          type: 'GET',
          data: data
        })
      )
    } else if (type === 'POST') {
      promise = $.ajax(
        $.extend(config, {
          type: 'POST',
          data: JSON.stringify(data)
        })
      )
    }

    promise.fail(function (jqXHR, message, errorType) {
      // sendEvent("Error", api, jqXHR.status);

      // logger.error("SEND ERROR");
      console.dir('polisAjax promise failed: ', arguments)
      if (jqXHR.status === 403) {
        // eb.trigger(eb.authNeeded);
      }
      // logger.dir(data);
      // logger.dir(message);
      // logger.dir(errorType);
    })
    return promise
  } else {
    let promise
    const config = {
      url: url,
      contentType: 'application/json; charset=utf-8',
      headers: {
        // "Cache-Control": "no-cache"  // no-cache
        'Cache-Control': 'max-age=0'
      },
      xhrFields: {
        withCredentials: true
      },
      // crossDomain: true,
      dataType: 'json'
    }
    if (type === 'GET') {
      promise = $.ajax(
        $.extend(config, {
          type: 'GET',
          data: data
        })
      )
    } else if (type === 'POST') {
      promise = $.ajax(
        $.extend(config, {
          type: 'POST',
          data: JSON.stringify(data)
        })
      )
    }

    promise.fail(function (jqXHR, message, errorType) {
      // sendEvent("Error", api, jqXHR.status);

      // logger.error("SEND ERROR");
      console.dir('polisAjax promise failed: ', arguments)
      if (jqXHR.status === 403) {
        // eb.trigger(eb.authNeeded);
      }
      // logger.dir(data);
      // logger.dir(message);
      // logger.dir(errorType);
    })
    return promise
  }
}

async function polisPost(api, data) {
  return await polisAjax(api, data, 'POST')
}

async function polisGet(api, data) {
  try {
    const d = await polisAjax(api, data, 'GET')
    return d
  } catch (error) {
    console.log(error)
  }
}

const PolisNet = {
  polisAjax: polisAjax,
  polisPost: polisPost,
  polisGet: polisGet,
  getAccessTokenSilentlySPA
}
export default PolisNet
