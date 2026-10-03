// Calls to /api/v3/ops/*. Kept apart from PolisNet.polisGet on purpose: that
// helper logs every non-2xx response and retries 403s, and here a 404 (ops is
// switched off) or a 403 (this login has no ops access) is the normal answer
// for almost every admin, so it must stay quiet.

import PolisNet from '../../util/net'
import URLs from '../../util/url'

export async function opsGet(path) {
  let token = null
  try {
    token = await PolisNet.getAccessTokenSilentlySPA()
  } catch {
    token = null
  }
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${URLs.urlPrefix}api/v3/ops/${path}`, {
    method: 'GET',
    headers,
    cache: 'no-store'
  })
  let body = null
  if (response.ok) {
    body = await response.json()
  }
  return { status: response.status, body }
}
