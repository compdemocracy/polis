import PropTypes from 'prop-types'
import { Routes, Route, Link, useParams } from 'react-router'
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

const PageRoute = () => {
  const { id } = useParams()
  return <OpsPage pageId={id} />
}

const Ops = () => {
  const { loading, ops, pages } = useOpsAccess()
  if (loading) return <Text sx={{ color: 'textSecondary' }}>Loading…</Text>
  if (!ops) return <NoAccess />
  return (
    <Routes>
      <Route index element={<Overview pages={pages} />} />
      <Route path=":group/:id" element={<PageRoute />} />
    </Routes>
  )
}

export default Ops
