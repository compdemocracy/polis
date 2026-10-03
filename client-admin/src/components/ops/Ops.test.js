import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Ops from './Ops'
import MainLayout from '../MainLayout'
import { opsGet } from './opsApi'
import { resetOpsAccessForTests } from './useOpsAccess'

jest.mock('./opsApi', () => ({ opsGet: jest.fn() }))

jest.mock('../InteriorHeader', () => {
  const Header = ({ children }) => <div>{children}</div>
  return Header
})

// Generated fixtures shaped like the server's /api/v3/ops responses.
const WHOAMI = {
  ops: true,
  pages: [
    {
      id: 'activity',
      group: 'usage',
      title: 'Activity now',
      summary: 'Votes, voters and new statements.',
      refresh_s: 60
    }
  ]
}

const ACTIVITY = {
  id: 'activity',
  group: 'usage',
  title: 'Activity now',
  summary: 'Votes, voters and new statements.',
  refresh_s: 60,
  generated_ms: 1_790_000_000_000,
  panels: [
    {
      id: 'votes',
      title: 'Voting',
      source: 'votes (zid, pid, created); index votes_created_idx',
      status: 'ok',
      as_of_ms: 1_790_000_000_000,
      cost_ms: 7,
      columns: [
        { key: 'window', label: 'Window', type: 'label' },
        { key: 'votes', label: 'Votes cast', type: 'count' },
        { key: 'voters', label: 'Participants voting', type: 'count' }
      ],
      rows: [
        { window: 'Last 5 minutes', votes: 3, voters: 2 },
        { window: 'Last hour', votes: 40, voters: 9 },
        { window: 'Last 24 hours', votes: 5120, voters: 60 }
      ]
    },
    {
      id: 'statements',
      title: 'New statements',
      source: 'comments; index comments_modified_idx',
      status: 'unavailable',
      reason: 'timeout',
      as_of_ms: null,
      cost_ms: null,
      columns: [],
      rows: []
    }
  ]
}

function respond(map) {
  opsGet.mockImplementation(async (path) => map[path] || { status: 404, body: null })
}

function renderAt(path, element) {
  return render(
    <ThemeUIProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{element}</Routes>
      </MemoryRouter>
    </ThemeUIProvider>
  )
}

beforeEach(() => {
  resetOpsAccessForTests()
  opsGet.mockReset()
})

describe('ops nav link', () => {
  const layout = (
    <Route element={<MainLayout />}>
      <Route path="/" element={<div>home</div>} />
    </Route>
  )

  it('is absent when the server answers 404 (OPS_ENABLED unset)', async () => {
    respond({})
    renderAt('/', layout)
    await waitFor(() => expect(opsGet).toHaveBeenCalledWith('whoami'))
    expect(screen.queryByText('Operations')).not.toBeInTheDocument()
  })

  it('is absent when the server answers 403', async () => {
    respond({ whoami: { status: 403, body: null } })
    renderAt('/', layout)
    await waitFor(() => expect(opsGet).toHaveBeenCalled())
    expect(screen.queryByText('Operations')).not.toBeInTheDocument()
  })

  it('appears after whoami answers 200', async () => {
    respond({ whoami: { status: 200, body: WHOAMI } })
    renderAt('/', layout)
    expect(await screen.findByText('Operations')).toBeInTheDocument()
  })
})

describe('/ops', () => {
  const ops = <Route path="/ops/*" element={<Ops />} />

  it('says so when the login has no access', async () => {
    respond({ whoami: { status: 403, body: null } })
    renderAt('/ops', ops)
    expect(await screen.findByText(/does not have access/)).toBeInTheDocument()
  })

  it('lists the pages', async () => {
    respond({ whoami: { status: 200, body: WHOAMI } })
    renderAt('/ops', ops)
    expect(await screen.findByRole('link', { name: 'Activity now' })).toHaveAttribute(
      'href',
      '/ops/usage/activity'
    )
  })

  it('draws U1 as one tile per window, with source, timing and an unavailable panel', async () => {
    respond({
      whoami: { status: 200, body: WHOAMI },
      'page/activity': { status: 200, body: ACTIVITY }
    })
    renderAt('/ops/usage/activity', ops)
    expect(await screen.findByRole('heading', { name: 'Activity now' })).toBeInTheDocument()
    expect(screen.getAllByTestId('ops-window-tile')).toHaveLength(3)
    expect(screen.getByLabelText('Votes cast: 5120')).toHaveTextContent('5,120')
    expect(screen.getByText(/index votes_created_idx/)).toBeInTheDocument()
    expect(screen.getByText('Read in 7 ms')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('the query passed its 3 s limit')
  })
})
