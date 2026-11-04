import './clientErrorReporter'
import URLs from './url'

const report = typeof window === 'undefined' ? () => {} : window.PolisClientErrors.install({
  client: 'report', build: (process.env.POLIS_BUILD_INFO || {}).commit, apiBase: URLs.urlPrefix
})
export function reportClientFetch(error, resource) {
  try {
    if (error && error.name === 'SyntaxError') report('fetch', { message: 'SyntaxError: Invalid JSON', stack: error.stack }, resource)
  } catch { /* Reporting must not affect the application. */ }
}
