import PropTypes from 'prop-types'
import { Box, Grid, Text } from 'theme-ui'

const fmt = new Intl.NumberFormat()

// One tile per time window. The first count column is the headline number;
// the others are listed under it. Columns and labels come from the server, so
// a new panel with the same shape needs no change here.
const WindowTiles = ({ columns, rows }) => {
  const label = columns.find((c) => c.type === 'label')
  const counts = columns.filter((c) => c.type === 'count')
  const [headline, ...rest] = counts
  if (!label || !headline) return null
  return (
    <Grid columns={[1, 3]} gap={3}>
      {rows.map((row) => (
        <Box
          key={row[label.key]}
          sx={{ p: 3, bg: 'secondary', borderRadius: 'md', minWidth: 0 }}
          data-testid="ops-window-tile">
          <Text as="div" sx={{ fontSize: 0, color: 'textSecondary', mb: 1 }}>
            {row[label.key]}
          </Text>
          <Text
            as="div"
            sx={{ fontSize: [5, 5, 6], fontWeight: 'bold', lineHeight: 'heading', color: 'text' }}
            aria-label={`${headline.label}: ${row[headline.key]}`}>
            {fmt.format(row[headline.key])}
          </Text>
          <Text as="div" sx={{ fontSize: 1, mb: 2 }}>
            {headline.label.toLowerCase()}
          </Text>
          <Box as="dl" sx={{ m: 0 }}>
            {rest.map((c) => (
              <Box
                key={c.key}
                sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
                <Text as="dt">{c.label}</Text>
                <Text as="dd" sx={{ m: 0, fontWeight: 'bold' }}>
                  {fmt.format(row[c.key])}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Grid>
  )
}

WindowTiles.propTypes = {
  columns: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      type: PropTypes.string.isRequired
    })
  ).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired
}

export default WindowTiles
