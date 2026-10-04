import PropTypes from 'prop-types'
import { Box, Grid, Text } from 'theme-ui'
import { formatValue } from './format'

// One row drawn as one tile per column (the database counters).
const StatTiles = ({ columns, row, now }) => (
  <Grid columns={[2, 3, 5]} gap={3}>
    {columns.map((c) => (
      <Box
        key={c.key}
        sx={{ p: 3, bg: 'secondary', borderRadius: 'md', minWidth: 0 }}
        data-testid="ops-stat-tile">
        <Text as="div" sx={{ fontSize: 0, color: 'textSecondary', mb: 1 }}>
          {c.label}
        </Text>
        <Text as="div" sx={{ fontSize: [3, 4], fontWeight: 'bold', color: 'text' }}>
          {formatValue(c, row[c.key], now)}
        </Text>
      </Box>
    ))}
  </Grid>
)

StatTiles.propTypes = {
  columns: PropTypes.array.isRequired,
  row: PropTypes.object.isRequired,
  now: PropTypes.number.isRequired
}

export default StatTiles
