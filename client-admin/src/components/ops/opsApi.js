// Calls to /api/v3/ops/*. Kept apart from PolisNet.polisGet on purpose: that
// helper logs every non-2xx response and retries 403s, and here a 404 (ops is
// switched off) or a 403 (this login has no ops access) is the normal answer
// for almost every admin, so it must stay quiet.

import PolisNet from '../../util/net'
import URLs from '../../util/url'

// The server bounds its own reads; this bounds the wait in the browser, so a
// request that never answers fails and is retried instead of hanging the page.
export const REQUEST_TIMEOUT_MS = 30 * 1000

export async function opsGet(path) {
  let token = null
  try {
    token = await PolisNet.getAccessTokenSilentlySPA()
  } catch {
    token = null
  }
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
  let response
  try {
    response = await fetch(`${URLs.urlPrefix}api/v3/ops/${path}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
  let body = null
  if (response.ok) {
    body = await response.json()
  }
  return { status: response.status, body }
}
