interface CheckmarkIconProps {
  size?: number
  className?: string
  circleColor?: string
  checkColor?: string
}

export default function CheckmarkIcon({
  size = 20,
  className,
  circleColor = '#03a9f4',
  checkColor = 'white'
}: CheckmarkIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="10" fill={circleColor} />
      <path
        d="M6 10L9 13L14 7"
        stroke={checkColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
