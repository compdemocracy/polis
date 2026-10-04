import PropTypes from 'prop-types'
import { Routes, Route, Link, useLocation, useParams } from 'react-router'
import { Box, Heading, Text } from 'theme-ui'
import useOpsAccess from './useOpsAccess'
import OpsPage from './OpsPage'

// /ops: the protected operations pages. Every number comes from the server's
// /api/v3/ops/page/:id, which decides access on each request; this component
// only decides what to draw.

const NoAccess = () => (
  <Box>
    <Heading as="h1" sx={{ fontSize: [4, 5], mb: 3 }}>
      Operations
    </Heading>
    <Text as="p">This login does not have access to the operations pages.</Text>
  </Box>
)

const Overview = ({ pages }) => (
  <Box>
    <Heading as="h1" sx={{ fontSize: [4, 5], mb: 2 }}>
      Operations
    </Heading>
    <Text as="p" sx={{ mb: 4, color: 'textSecondary' }}>
      Read-only, aggregate views of the production system.
    </Text>
    <Box as="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {pages.map((p) => (
        <Box as="li" key={p.id} sx={{ py: 3, borderBottom: '1px solid', borderColor: 'border' }}>
          <Link sx={{ variant: 'links.nav' }} to={`/ops/${p.group}/${p.id}`}>
            {p.title}
          </Link>
          <Text as="p" sx={{ mt: 1, mb: 0, fontSize: 1 }}>
            {p.summary}
          </Text>
        </Box>
      ))}
    </Box>
  </Box>
)

Overview.propTypes = {
  pages: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      group: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
      summary: PropTypes.string
    })
  ).isRequired
}

const GROUP_LABELS = { usage: 'Usage', system: 'System' }

// A plain tab row: every page, grouped as the server groups them. The current
// page is marked with aria-current and an underline.
export const OpsTabs = ({ pages }) => {
  const { pathname } = useLocation()
  // Array.from, not spread: the build compiles spread loosely, which breaks on a Set.
  const groups = Array.from(new Set(pages.map((p) => p.group)))
  const tab = (to, label, active) => (
    <Link
      key={to}
      to={to}
      aria-current={active ? 'page' : undefined}
      sx={{
        display: 'inline-block',
        px: 2,
        py: 2,
        fontSize: 1,
        color: active ? 'text' : 'textSecondary',
        fontWeight: active ? 'bold' : 'body',
        textDecoration: 'none',
        borderBottom: '2px solid',
        borderColor: active ? 'primary' : 'transparent'
      }}>
      {label}
    </Link>
  )
  const overview = pathname.replace(/\/+$/, '') === '/ops'
  return (
    <Box
      as="nav"
      aria-label="Operations pages"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 3,
        rowGap: 1,
        mb: 4,
        borderBottom: '1px solid',
        borderColor: 'border'
      }}>
      {tab('/ops', 'Overview', overview)}
      {groups.map((g) => (
        <Box key={g} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <Text sx={{ fontSize: 0, color: 'textSecondary', textTransform: 'uppercase', mr: 1 }}>
            {GROUP_LABELS[g] || g}
          </Text>
          {pages
            .filter((p) => p.group === g)
            .map((p) => {
              const to = `/ops/${p.group}/${p.id}`
              return tab(to, p.title, pathname.startsWith(to))
            })}
        </Box>
      ))}
    </Box>
  )
}

OpsTabs.propTypes = Overview.propTypes

const PageRoute = () => {
  const { id } = useParams()
  return <OpsPage pageId={id} />
}

const Ops = () => {
  const { loading, ops, pages } = useOpsAccess()
  if (loading) return <Text sx={{ color: 'textSecondary' }}>Loading…</Text>
  if (!ops) return <NoAccess />
  return (
    <Box>
      <OpsTabs pages={pages} />
      <Routes>
        <Route index element={<Overview pages={pages} />} />
        <Route path=":group/:id" element={<PageRoute />} />
      </Routes>
    </Box>
  )
}

export default Ops
