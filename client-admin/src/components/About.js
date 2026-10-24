import { useEffect, useState } from 'react'

const client = process.env.POLIS_BUILD_INFO

export default function About() {
  const [server, setServer] = useState(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/v3/version', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Version unavailable')
        return response.json()
      })
      .then(setServer)
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true) })
    return () => controller.abort()
  }, [])
  return (
    <section>
      <h1>About Polis</h1>
      <h2>Admin: {client.version_display}</h2>
      <p>Commit: {client.commit}</p>
      <p>Commits ahead of stable: {client.distance ?? 'unknown'}</p>
      {server && <>
        <h2>Server: {server.version_display}</h2>
        <p>Commit: {server.commit}</p>
        <p>Commits ahead of stable: {server.distance ?? 'unknown'}</p>
        <p>{server.commit === client.commit && server.version_display === client.version_display
          ? 'Client and server builds match.' : 'Client and server builds differ.'}</p>
      </>}
      {unavailable && <p>Server version unavailable.</p>}
    </section>
  )
}
