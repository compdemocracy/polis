import PropTypes from 'prop-types'

const Logomark = ({ style, fill }) => {
  return (
    <svg
      width="20"
      viewBox="0 0 88 100"
      style={style}
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M44 0L87.3013 25V75L44 100L0.69873 75V25L44 0Z" fill={fill} />
    </svg>
  )
}

Logomark.propTypes = {
  style: PropTypes.object,
  fill: PropTypes.string
}

export default Logomark
