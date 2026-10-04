import PropTypes from 'prop-types'
import { Box, Text } from 'theme-ui'
import { formatValue, isNumeric, MISSING } from './format'

// A sorted table as the server sent it. A column of type "group" is not a
// column: consecutive rows with the same value are drawn under one heading
// row (U5: one conversation per group).

function Tags({ value }) {
  if (value === null) {
    return <Text sx={{ color: 'textSecondary', fontSize: 0 }}>could not be read</Text>
  }
  if (!Array.isArray(value) || value.length === 0) return MISSING
  return (
    <Box as="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {value.map((tag) => (
        <Box
          as="li"
          key={tag}
          sx={{ fontSize: 0, px: 2, py: '2px', bg: 'secondary', borderRadius: 'full' }}>
          {tag}
        </Box>
      ))}
    </Box>
  )
}

Tags.propTypes = { value: PropTypes.arrayOf(PropTypes.string) }

// A non-zero sequential-scan rate on a table that is not expected to be
// scanned (votes, comments, math_main, ...) is the September 2026 incident
// signal; it is drawn in the error colour.
function alarming(column, row) {
  return (
    column.key === 'seq_scans_per_min' &&
    row.expected_seq === false &&
    typeof row[column.key] === 'number' &&
    row[column.key] > 0
  )
}

const cell = {
  py: 2,
  px: 2,
  borderBottom: '1px solid',
  borderColor: 'border',
  verticalAlign: 'top',
  fontSize: 1
}

const OpsTable = ({ columns, rows, now }) => {
  const group = columns.find((c) => c.type === 'group')
  const shown = columns.filter((c) => c.type !== 'group')
  const body = []
  let lastGroup
  rows.forEach((row, i) => {
    if (group && row[group.key] !== lastGroup) {
      lastGroup = row[group.key]
      body.push(
        <tr key={`g${i}`}>
          <Box
            as="th"
            colSpan={shown.length}
            scope="colgroup"
            sx={{ ...cell, pt: 4, textAlign: 'left', fontSize: 2, color: 'text' }}>
            {String(lastGroup)}
          </Box>
        </tr>
      )
    }
    body.push(
      <tr key={i}>
        {shown.map((c) => (
          <Box
            as="td"
            key={c.key}
            sx={{
              ...cell,
              textAlign: isNumeric(c) ? 'right' : 'left',
              whiteSpace: isNumeric(c) || c.type === 'time' ? 'nowrap' : 'normal',
              maxWidth: c.type === 'text' ? '36em' : undefined,
              color: alarming(c, row) ? 'error' : undefined,
              fontWeight: alarming(c, row) ? 'bold' : undefined
            }}>
            {c.type === 'tags' ? <Tags value={row[c.key]} /> : formatValue(c, row[c.key], now)}
          </Box>
        ))}
      </tr>
    )
  })
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {shown.map((c) => (
              <Box
                as="th"
                key={c.key}
                scope="col"
                sx={{
                  ...cell,
                  fontSize: 0,
                  color: 'textSecondary',
                  textAlign: isNumeric(c) ? 'right' : 'left'
                }}>
                {c.label}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </Box>
    </Box>
  )
}

OpsTable.propTypes = {
  columns: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      type: PropTypes.string.isRequired
    })
  ).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  now: PropTypes.number.isRequired
}

export default OpsTable
