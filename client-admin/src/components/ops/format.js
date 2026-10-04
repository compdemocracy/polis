// How the ops pages print a value of each column type the server declares
// (server/src/ops/types.ts). A missing value is an em dash, never a zero.

const counts = new Intl.NumberFormat('en-US')
const percents = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })

export const MISSING = '—'

export function formatAge(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

let regionNames = null
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
} catch {
  regionNames = null
}

// "US" -> "United States (US)" where the runtime knows the name.
export function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || !regionNames) return code
  try {
    const name = regionNames.of(code)
    return name && name !== code ? `${name} (${code})` : code
  } catch {
    return code
  }
}

export function formatValue(column, value, now = Date.now()) {
  if (value === null || value === undefined) return MISSING
  switch (column.type) {
    case 'count':
      return typeof value === 'number' ? counts.format(value) : String(value)
    case 'number': {
      if (typeof value !== 'number') return String(value)
      const digits = column.digits ?? 1
      const text = value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      })
      return column.unit ? `${text} ${column.unit}` : text
    }
    case 'percent':
      return typeof value === 'number' ? percents.format(value) : String(value)
    case 'time':
      return typeof value === 'number' ? formatAge(value, now) : String(value)
    case 'tags':
      return Array.isArray(value) ? value.join(', ') || MISSING : String(value)
    default:
      return column.key === 'country' ? countryName(value) : String(value)
  }
}

export function isNumeric(column) {
  return ['count', 'number', 'percent'].includes(column.type)
}
