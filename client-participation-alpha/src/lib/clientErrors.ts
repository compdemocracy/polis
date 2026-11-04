import './clientErrorReporter'

type Report = (kind: string, error: unknown, resource?: string) => void

declare global {
  interface Window {
    PolisClientErrors: {
      install: (options: { client: string; build?: string; apiBase?: string }) => Report
    }
  }
}
const identity = process.env.POLIS_BUILD_INFO as unknown as { commit?: string } | undefined
const report: Report =
  typeof window === 'undefined'
    ? () => {}
    : window.PolisClientErrors.install({
        client: 'alpha',
        build: identity?.commit,
        apiBase: import.meta.env.PUBLIC_SERVICE_URL || '/'
      })
export function reportClientFetch(error: unknown, resource: string) {
  try {
    if (error instanceof SyntaxError)
      report('fetch', { message: 'SyntaxError: Invalid JSON', stack: error.stack }, resource)
  } catch {
    /* Reporting must not affect the application. */
  }
}
