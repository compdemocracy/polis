interface TestButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  className?: string
}

export default function TestButton({
  label,
  onClick,
  disabled = false,
  className = ''
}: TestButtonProps) {
  return (
    <button
      className={`test-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {label}
    </button>
  )
}
