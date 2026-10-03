import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { Box, Flex, Heading, Text } from 'theme-ui'
import { opsGet } from './opsApi'
import WindowTiles from './WindowTiles'
import OpsTable from './OpsTable'
import StatTiles from './StatTiles'
import SeriesChart from './SeriesChart'
import { formatAge } from './format'

const MAX_BACKOFF_MS = 5 * 60 * 1000

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const REASONS = {
  timeout: 'the query passed its 3 s limit',
  lock_timeout: 'the query waited on a lock',
  pool_busy: 'no database connection was free',
  db_error: 'the database refused the query',
  bad_value: 'the source returned a value out of range',
  sa_unauthorized: 'Simple Analytics refused the API key',
  sa_not_found: 'Simple Analytics does not know this site',
  sa_rate_limited: 'Simple Analytics is rate limiting this server',
  sa_http_error: 'Simple Analytics answered with an error',
  sa_timeout: 'Simple Analytics did not answer in time',
  sa_unreachable: 'Simple Analytics could not be reached',
  sa_malformed: 'Simple Analytics sent an unexpected answer',
  not_permitted: 'not permitted (CDK PR3 pending)',
  aws_no_credentials: 'no instance role credentials on this server',
  aws_timeout: 'AWS did not answer in time',
  aws_throttled: 'AWS is rate limiting this server',
  aws_not_found: 'AWS does not know this resource',
  aws_malformed: 'AWS sent an unexpected answer',
  aws_error: 'the AWS read failed',
  error: 'the read failed'
}

function PanelBody({ panel, now }) {
  switch (panel.shape) {
    case 'table':
      return <OpsTable columns={panel.columns} rows={panel.rows} now={now} />
    case 'series':
      return <SeriesChart columns={panel.columns} rows={panel.rows} now={now} />
    case 'stats':
      return <StatTiles columns={panel.columns} row={panel.rows[0]} now={now} />
    default:
      return <WindowTiles columns={panel.columns} rows={panel.rows} />
  }
}

PanelBody.propTypes = {
  panel: PropTypes.object.isRequired,
  now: PropTypes.number.isRequired
}

export function PanelFooter({ panel, now }) {
  return (
    <Flex
      sx={{
        mt: 3,
        pt: 2,
        borderTop: '1px solid',
        borderColor: 'border',
        flexWrap: 'wrap',
        gap: 3,
        fontSize: 0,
        color: 'textSecondary'
      }}>
      <Text>Source: {panel.source}</Text>
      {panel.as_of_ms ? (
        <Text title={new Date(panel.as_of_ms).toISOString()}>
          As of {formatClock(panel.as_of_ms)} ({formatAge(panel.as_of_ms, now)})
        </Text>
      ) : null}
      {panel.cost_ms !== null && panel.cost_ms !== undefined ? (
        <Text>Read in {panel.cost_ms} ms</Text>
      ) : null}
    </Flex>
  )
}

PanelFooter.propTypes = {
  panel: PropTypes.object.isRequired,
  now: PropTypes.number.isRequired
}

export function Panel({ panel, now }) {
  const unavailable = panel.status !== 'ok'
  return (
    <Box
      as="section"
      aria-labelledby={`ops-panel-${panel.id}`}
      sx={{ mb: 5, p: [3, 4], border: '1px solid', borderColor: 'border', borderRadius: 'lg' }}>
      <Flex sx={{ alignItems: 'baseline', justifyContent: 'space-between', mb: 3, gap: 2 }}>
        <Heading as="h2" id={`ops-panel-${panel.id}`} sx={{ fontSize: 3 }}>
          {panel.title}
        </Heading>
        {unavailable ? (
          <Text
            role="status"
            sx={{
              fontSize: 0,
              px: 2,
              py: 1,
              borderRadius: 'sm',
              bg: 'warning',
              color: 'black'
            }}>
            Unavailable: {REASONS[panel.reason] || panel.reason}
            {panel.rows.length ? ', showing the last good read' : ''}
          </Text>
        ) : null}
      </Flex>
      <Box sx={{ opacity: unavailable ? 0.5 : 1 }}>
        {panel.rows.length ? (
          <PanelBody panel={panel} now={now} />
        ) : (
          <Text sx={{ color: 'textSecondary' }}>
            {panel.status === 'ok' && panel.as_of_ms ? 'Nothing in this window.' : 'No data yet.'}
          </Text>
        )}
        {panel.note ? (
          <Text as="p" sx={{ mt: 3, mb: 0, fontSize: 1, maxWidth: '50em' }}>
            {panel.note}
          </Text>
        ) : null}
      </Box>
      <PanelFooter panel={panel} now={now} />
    </Box>
  )
}

Panel.propTypes = {
  panel: PropTypes.shape({
    id: PropTypes.string.isRequired,
    title: PropTypes.string.isRequired,
    source: PropTypes.string.isRequired,
    shape: PropTypes.string,
    note: PropTypes.string,
    status: PropTypes.string.isRequired,
    reason: PropTypes.string,
    as_of_ms: PropTypes.number,
    cost_ms: PropTypes.number,
    columns: PropTypes.array.isRequired,
    rows: PropTypes.array.isRequired
  }).isRequired,
  now: PropTypes.number.isRequired
}

// Polls one page at its refresh interval while the tab is visible. A failed
// fetch keeps the last page on screen and retries with doubling delays.
const OpsPage = ({ pageId }) => {
  const [page, setPage] = useState(null)
  const [failure, setFailure] = useState(null)
  const [now, setNow] = useState(Date.now())
  const timer = useRef(null)
  const backoff = useRef(0)

  const load = useCallback(async () => {
    clearTimeout(timer.current)
    let delayMs = 60 * 1000
    try {
      const { status, body } = await opsGet(`page/${encodeURIComponent(pageId)}`)
      if (status === 200 && body) {
        setPage(body)
        setFailure(null)
        backoff.current = 0
        delayMs = (body.refresh_s || 60) * 1000
      } else {
        setFailure(status === 403 ? 'forbidden' : status === 404 ? 'missing' : 'error')
        if (status === 403 || status === 404) return
        backoff.current = Math.min(Math.max(backoff.current * 2, 15000), MAX_BACKOFF_MS)
        delayMs = backoff.current
      }
    } catch {
      setFailure('error')
      backoff.current = Math.min(Math.max(backoff.current * 2, 15000), MAX_BACKOFF_MS)
      delayMs = backoff.current
    }
    setNow(Date.now())
    if (document.visibilityState !== 'hidden') {
      timer.current = setTimeout(load, delayMs)
    }
  }, [pageId])

  useEffect(() => {
    load()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer.current)
      } else {
        load()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    const tick = setInterval(() => setNow(Date.now()), 5000)
    return () => {
      clearTimeout(timer.current)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  if (failure === 'forbidden') {
    return <Text>This login does not have access to the operations pages.</Text>
  }
  if (failure === 'missing') {
    return <Text>This page does not exist.</Text>
  }
  if (!page) {
    return <Text sx={{ color: 'textSecondary' }}>{failure ? 'Could not load.' : 'Loading…'}</Text>
  }

  return (
    <Box>
      <Heading as="h1" sx={{ fontSize: [4, 5], mb: 2 }}>
        {page.title}
      </Heading>
      <Text as="p" sx={{ mb: 2, maxWidth: '40em' }}>
        {page.summary}
      </Text>
      {page.notice ? (
        <Text as="p" role="status" sx={{ mb: 4, p: 3, bg: 'secondary', borderRadius: 'md' }}>
          {page.notice}
        </Text>
      ) : (
        <Text as="p" sx={{ mb: 4, fontSize: 0, color: 'textSecondary' }}>
          Refreshes every {page.refresh_s} s while this tab is open; the server reads each source at
          most once a minute (every 15 minutes for the slowest panels) however many people are
          looking
          {failure ? '. The last refresh failed; retrying.' : '.'}
        </Text>
      )}
      {page.panels.map((panel) => (
        <Panel key={panel.id} panel={panel} now={now} />
      ))}
    </Box>
  )
}

OpsPage.propTypes = {
  pageId: PropTypes.string.isRequired
}

export default OpsPage
