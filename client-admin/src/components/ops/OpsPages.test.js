import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Ops from './Ops'
import { opsGet } from './opsApi'
import { resetOpsAccessForTests } from './useOpsAccess'
import { formatValue, countryName } from './format'

jest.mock('./opsApi', () => ({ opsGet: jest.fn() }))

// Generated fixtures shaped like the server's /api/v3/ops responses for the
// pages added after U1.
const page = (id, group, title) => ({ id, group, title, summary: `${title}.`, refresh_s: 60 })
const WHOAMI = {
  ops: true,
  pages: [
    page('activity', 'usage', 'Activity now'),
    page('history', 'usage', 'Activity over time'),
    page('origin', 'usage', 'Where visitors come from'),
    page('topics', 'usage', 'What people are talking about'),
    page('consensus', 'usage', 'What consensus they found'),
    page('db', 'system', 'Database')
  ]
}

const base = {
  status: 'ok',
  as_of_ms: 1_790_000_000_000,
  cost_ms: 12,
  source: 'generated fixture source'
}

const body = (id, title, panels, extra = {}) => ({
  id,
  title,
  summary: `${title}.`,
  refresh_s: 60,
  generated_ms: 1_790_000_000_000,
  panels,
  ...extra
})

function respond(map) {
  opsGet.mockImplementation(async (path) => map[path] || { status: 404, body: null })
}

function renderAt(path) {
  return render(
    <ThemeUIProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ops/*" element={<Ops />} />
        </Routes>
      </MemoryRouter>
    </ThemeUIProvider>
  )
}

beforeEach(() => {
  resetOpsAccessForTests()
  opsGet.mockReset()
})

describe('tab row', () => {
  it('lists every page under its group and marks the current one', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/db': { status: 200, body: body('db', 'Database', []) }
    })
    renderAt('/ops/system/db')
    const nav = await screen.findByRole('navigation', { name: 'Operations pages' })
    expect(within(nav).getAllByRole('link')).toHaveLength(7)
    expect(within(nav).getByText('System')).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Database' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
  })
})

describe('where visitors come from', () => {
  it('without a key shows the sentence and nothing else', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/origin': {
        status: 200,
        body: body('origin', 'Where visitors come from', [], {
          notice:
            'Simple Analytics is not configured on this server (SIMPLE_ANALYTICS_API_KEY is unset), so this page has nothing to show.'
        })
      }
    })
    renderAt('/ops/usage/origin')
    expect(await screen.findByRole('status')).toHaveTextContent('SIMPLE_ANALYTICS_API_KEY is unset')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText(/Refreshes every/)).not.toBeInTheDocument()
  })

  it('draws the country table with names and a closed failure reason', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/origin': {
        status: 200,
        body: body('origin', 'Where visitors come from', [
          {
            ...base,
            id: 'countries',
            title: 'By country',
            shape: 'table',
            columns: [
              { key: 'country', label: 'Country', type: 'label' },
              { key: 'participation', label: 'Participation pageviews', type: 'count' },
              { key: 'total', label: 'Total', type: 'count' }
            ],
            rows: [
              { country: 'US', participation: 1200, total: 1500 },
              { country: 'Other', participation: 3, total: 9 }
            ]
          },
          {
            ...base,
            id: 'referrers',
            title: 'By referring site',
            shape: 'table',
            status: 'unavailable',
            reason: 'sa_unauthorized',
            columns: [],
            rows: []
          }
        ])
      }
    })
    renderAt('/ops/usage/origin')
    expect(await screen.findByText('United States (US)')).toBeInTheDocument()
    expect(screen.getByText('1,500')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Simple Analytics refused the API key')
  })
})

describe('history', () => {
  it('draws one bar chart per charted column, the newest bucket lighter, numbers on request', async () => {
    const rows = [
      { period: '2026-10-01', partial: false, votes: 10, voters: 4 },
      { period: '2026-10-02', partial: false, votes: 0, voters: 0 },
      { period: '2026-10-03', partial: true, votes: 5, voters: 2 }
    ]
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/history': {
        status: 200,
        body: body('history', 'Activity over time', [
          {
            ...base,
            id: 'daily',
            title: 'Per day, last 90 days',
            shape: 'series',
            columns: [
              { key: 'period', label: 'Period (UTC)', type: 'label' },
              { key: 'votes', label: 'Votes', type: 'count', chart: true },
              { key: 'voters', label: 'Participants voting', type: 'count', chart: true }
            ],
            rows
          }
        ])
      }
    })
    const { container } = renderAt('/ops/usage/history')
    expect(
      await screen.findByRole('img', { name: /Votes from 2026-10-01 to 2026-10-03, peak 10/ })
    ).toBeInTheDocument()
    expect(container.querySelectorAll('svg')).toHaveLength(2)
    const bars = container.querySelectorAll('svg')[0].querySelectorAll('rect')
    expect(bars).toHaveLength(3)
    expect(bars[2].getAttribute('opacity')).toBe('0.4')
    expect(bars[0].getAttribute('opacity')).toBe('1')
    expect(screen.getByText('All numbers (3 rows)')).toBeInTheDocument()
  })
})

describe('topics and consensus', () => {
  it('draws topic chips, a failed Delphi read, and the threshold note', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/topics': {
        status: 200,
        body: body('topics', 'What people are talking about', [
          {
            ...base,
            id: 'active',
            title: 'Most active conversations, last 7 days',
            shape: 'table',
            note: '3 conversations with fewer than 20 voters in the window (12 voters between them) counted but not named.',
            columns: [
              { key: 'topic', label: 'Conversation topic', type: 'text' },
              { key: 'delphi_topics', label: 'Delphi topics', type: 'tags' },
              { key: 'voters', label: 'Voters, 7 days', type: 'count' }
            ],
            rows: [
              { topic: 'Generated topic one', delphi_topics: ['Bus lanes', 'Fares'], voters: 40 },
              { topic: 'Generated topic two', delphi_topics: null, voters: 21 }
            ]
          }
        ])
      }
    })
    renderAt('/ops/usage/topics')
    expect(await screen.findByText('Bus lanes')).toBeInTheDocument()
    expect(screen.getByText('could not be read')).toBeInTheDocument()
    expect(screen.getByText(/counted but not named/)).toBeInTheDocument()
  })

  it('groups consensus rows under one heading per conversation', async () => {
    const conv = 'Generated topic · 23 participants in 2 groups'
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/consensus': {
        status: 200,
        body: body('consensus', 'What consensus they found', [
          {
            ...base,
            id: 'findings',
            title: 'Common ground and what sets each group apart',
            shape: 'table',
            columns: [
              { key: 'conversation', label: 'Conversation', type: 'group' },
              { key: 'finding', label: 'Finding', type: 'label' },
              { key: 'statement', label: 'Statement', type: 'text' },
              { key: 'agree', label: 'Agree', type: 'percent' }
            ],
            rows: [
              { conversation: conv, finding: 'Common ground 1', statement: 'S one', agree: 0.912 },
              { conversation: conv, finding: 'Group A · 12 people', statement: 'S two', agree: 0.5 }
            ]
          }
        ])
      }
    })
    renderAt('/ops/usage/consensus')
    expect(await screen.findAllByRole('columnheader', { name: conv })).toHaveLength(1)
    expect(screen.queryByRole('columnheader', { name: 'Conversation' })).not.toBeInTheDocument()
    expect(screen.getByText('91.2%')).toBeInTheDocument()
  })
})

describe('database', () => {
  it('draws counters as tiles and an unexpected sequential scan rate in the error colour', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/db': {
        status: 200,
        body: body('db', 'Database', [
          {
            ...base,
            id: 'tables',
            title: 'Sequential-scan watch',
            shape: 'table',
            columns: [
              { key: 'table', label: 'Table', type: 'label' },
              { key: 'seq_scans_per_min', label: 'Seq scans / min', type: 'number', digits: 1 }
            ],
            rows: [
              { table: 'votes', expected_seq: false, seq_scans_per_min: 2 },
              { table: 'conversations', expected_seq: true, seq_scans_per_min: 3 },
              { table: 'comments', expected_seq: false, seq_scans_per_min: null }
            ]
          },
          {
            ...base,
            id: 'counters',
            title: 'Database counters',
            shape: 'stats',
            columns: [
              { key: 'backends', label: 'Connections', type: 'count' },
              { key: 'cache_hit_now', label: 'Cache hit ratio, last interval', type: 'percent' }
            ],
            rows: [{ backends: 31, cache_hit_now: null }]
          }
        ])
      }
    })
    renderAt('/ops/system/db')
    const votes = await screen.findByText('2.0')
    expect(votes).toHaveStyle({ color: 'var(--theme-ui-colors-error)' })
    expect(screen.getByText('3.0')).not.toHaveStyle({ color: 'var(--theme-ui-colors-error)' })
    expect(screen.getAllByTestId('ops-stat-tile')).toHaveLength(2)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })
})

describe('format', () => {
  it.each([
    [{ type: 'count' }, 12345, '12,345'],
    [{ type: 'number', digits: 1, unit: 's' }, 2.25, '2.3 s'],
    [{ type: 'percent' }, 0.5, '50%'],
    [{ type: 'count' }, null, '—'],
    [{ type: 'tags' }, [], '—']
  ])('%p %p -> %p', (column, value, text) => {
    expect(formatValue({ key: 'k', label: 'k', ...column }, value)).toBe(text)
  })

  it('leaves anything but a two-letter code alone', () => {
    expect(countryName('Unknown')).toBe('Unknown')
    expect(countryName('DE')).toBe('Germany (DE)')
  })
})
