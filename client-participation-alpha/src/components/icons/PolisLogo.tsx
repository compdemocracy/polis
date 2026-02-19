interface PolisLogoProps {
  size?: number
  className?: string
}

export default function PolisLogo({ size = 50, className }: PolisLogoProps) {
  // Scale factor based on original viewBox height of 304
  const scale = size / 304

  return (
    <svg
      width={264 * scale}
      height={size}
      viewBox="0 0 264 304"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Polis logo"
      // When the page is `dir=rtl`, some browsers can inherit RTL direction into SVG text layout,
      // which can shift/clamp the "p." glyphs. Force LTR + isolate bidi for consistent rendering.
      style={{ direction: 'ltr', unicodeBidi: 'isolate' }}
    >
      {/* Blue hexagon background */}
      <polygon
        fill="#0090ff"
        points="131.734836 0 263.469671 76 263.469671 228 131.734836 304 0 228 0 76"
      />

      {/* Decorative lines */}
      <path
        d="M37.7142857,90.446281 L47.7714286,115.570248"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M212.457143,162.049587 L240.114286,119.338843"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M182.285714,244.958678 L208.685714,226.115702"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M130.742857,268.826446 L153.371429,226.115702"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M25.1428571,195.966942 L47.7714286,120.595041"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M104.342857,54.0165289 L148.342857,67.8347107"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />
      <path
        d="M95.5428571,70.3471074 L103.085714,55.2727273"
        stroke="#FFFFFF"
        strokeWidth="0.3"
        strokeLinecap="square"
        fill="none"
      />

      {/* "p." text */}
      <text
        fontFamily="Georgia, serif"
        fontSize="179.950051"
        fontWeight="normal"
        fill="#FFFFFF"
        x="77.9428571"
        y="180.07438"
      >
        p.
      </text>

      {/* Decorative dots */}
      <ellipse fill="#FFFFFF" cx="240.114286" cy="119.338843" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="189.828571" cy="94.214876" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="36.4571429" cy="89.1900826" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="49.0285714" cy="116.826446" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="23.8857143" cy="197.22314" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="154.628571" cy="224.859504" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="149.6" cy="69.0909091" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="94.2857143" cy="71.6033058" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="104.342857" cy="54.0165289" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="129.485714" cy="43.9669421" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="129.485714" cy="270.082645" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="182.285714" cy="244.958678" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="182.285714" cy="219.834711" rx="3.77142857" ry="3.76859504" />
      <ellipse fill="#FFFFFF" cx="207.428571" cy="227.371901" rx="3.77142857" ry="3.76859504" />
    </svg>
  )
}
