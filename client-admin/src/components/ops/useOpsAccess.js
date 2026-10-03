import { useEffect, useState } from 'react'
import { opsGet } from './opsApi'

// One whoami per page load: the nav link and the /ops overview share it.
let whoamiPromise = null

export function fetchOpsAccess() {
  if (!whoamiPromise) {
    whoamiPromise = opsGet('whoami')
      .then(({ status, body }) =>
        status === 200 && body && body.ops === true
          ? { ops: true, pages: body.pages || [] }
          : { ops: false, pages: [], status }
      )
      .catch(() => ({ ops: false, pages: [], status: 0 }))
  }
  return whoamiPromise
}

// Tests only.
export function resetOpsAccessForTests() {
  whoamiPromise = null
}

// { loading, ops, pages }. ops is true only after the server answered 200 to
// /api/v3/ops/whoami; with OPS_ENABLED unset the server answers 404 and this
// stays false, so nothing about ops is shown.
export default function useOpsAccess() {
  const [state, setState] = useState({ loading: true, ops: false, pages: [] })
  useEffect(() => {
    let live = true
    fetchOpsAccess().then((access) => {
      if (live) setState({ loading: false, ...access })
    })
    return () => {
      live = false
    }
  }, [])
  return state
}
