import PropTypes from 'prop-types'
import { Box, Text } from 'theme-ui'
import OpsTable from './OpsTable'
import { formatValue } from './format'

// A time series as small bar charts, one per charted column, drawn as inline
// SVG (no chart library), with every number in a table under a disclosure.
// The newest bucket is still filling and is drawn lighter.

const WIDTH = 720
const HEIGHT = 96

function Bars({ column, rows, labelKey }) {
  const values = rows.map((r) => (typeof r[column.key] === 'number' ? r[column.key] : 0))
  const peak = Math.max(0, ...values)
  const max = Math.max(1, peak)
  const step = WIDTH / Math.max(1, rows.length)
  const bar = Math.max(1, step - (step > 4 ? 1 : 0))
  const first = rows[0]?.[labelKey]
  const last = rows[rows.length - 1]?.[labelKey]
  const total = values.reduce((n, v) => n + v, 0)
  return (
    <Box as="figure" sx={{ m: 0, mb: 3 }}>
      <Text as="figcaption" sx={{ fontSize: 1, mb: 1, color: 'text' }}>
        {column.label}{' '}
        <Text as="span" sx={{ color: 'textSecondary', fontSize: 0 }}>
          peak {formatValue(column, peak)}, total {formatValue(column, total)}
        </Text>
      </Text>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label={`${column.label} from ${first} to ${last}, peak ${peak}`}>
        <line x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="#e5e7eb" />
        {rows.map((r, i) => {
          const h = Math.round((values[i] / max) * (HEIGHT - 4))
          return (
            <rect
              key={i}
              x={i * step}
              y={HEIGHT - h}
              width={bar}
              height={h}
              fill="#03a9f4"
              opacity={r.partial ? 0.4 : 1}>
              <title>{`${r[labelKey]}: ${formatValue(column, values[i])}${
                r.partial ? ' (so far)' : ''
              }`}</title>
            </rect>
          )
        })}
      </svg>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 0,
          color: 'textSecondary'
        }}>
        <span>{first}</span>
        <span>{last}</span>
      </Box>
    </Box>
  )
}

Bars.propTypes = {
  column: PropTypes.object.isRequired,
  rows: PropTypes.array.isRequired,
  labelKey: PropTypes.string.isRequired
}

const SeriesChart = ({ columns, rows, now }) => {
  const label = columns.find((c) => c.type === 'label')
  const charted = columns.filter((c) => c.chart)
  if (!label) return null
  return (
    <Box>
      {charted.map((c) => (
        <Bars key={c.key} column={c} rows={rows} labelKey={label.key} />
      ))}
      <Box as="details" sx={{ mt: 2 }}>
        <Box as="summary" sx={{ cursor: 'pointer', fontSize: 1 }}>
          All numbers ({rows.length} rows)
        </Box>
        <OpsTable columns={columns} rows={[...rows].reverse()} now={now} />
      </Box>
    </Box>
  )
}

SeriesChart.propTypes = {
  columns: PropTypes.array.isRequired,
  rows: PropTypes.array.isRequired,
  now: PropTypes.number.isRequired
}

export default SeriesChart
