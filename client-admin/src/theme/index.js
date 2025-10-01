export default {
  // Mobile-first breakpoints for responsive design
  // Breakpoint values: ['48em', '75em'] = [768px, 1200px]
  // Usage in responsive arrays: [mobile, tablet, desktop]
  // Example: fontSize: [2, 3, 4] applies fontSize 2 on mobile, 3 at ≥768px, 4 at ≥1200px
  breakpoints: ['48em', '75em'],

  space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 128, 256, 512],
  fonts: {
    body:
      // 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      "'Space Mono', monospace",
    heading: 'inherit',
    monospace: "'Space Mono', monospace"
  },
  fontSizes: [12, 14, 16, 20, 24, 32, 48, 64, 96],
  fontWeights: {
    body: 400,
    heading: 700,
    bold: 700
  },
  sizes: {
    container: ['100%', '100%', '80em'],
    touchTarget: 44, // Minimum touch target for accessibility
    maxWidth: {
      paragraph: '35em'
    }
  },
  radii: {
    none: 0,
    sm: 2,
    default: 4,
    md: 4,
    lg: 8,
    xl: 16,
    full: 9999
  },
  shadows: {
    none: 'none',
    sm: '0 1px 3px rgba(0, 0, 0, 0.12)',
    default: '0 0 8px rgba(0, 0, 0, 0.125)',
    md: '0 4px 6px rgba(0, 0, 0, 0.1)',
    lg: '0 10px 20px rgba(0, 0, 0, 0.15)',
    xl: '0 20px 40px rgba(0, 0, 0, 0.2)'
  },
  transitions: {
    fast: 'all 0.15s ease',
    default: 'all 0.2s ease',
    slow: 'all 0.3s ease'
  },
  lineHeights: {
    body: 1.5,
    heading: 1.125
  },
  colors: {
    text: '#60656f',
    background: '#FFF',
    primary: '#03a9f4',
    secondary: '#f6f7f8',
    mediumGray: '#60656f',
    textSecondary: '#8a9099',
    // Semantic colors for status/feedback
    muted: '#f3f4f6',
    border: '#e5e7eb',
    success: '#4dd599',
    successHover: '#3dbd85',
    error: '#f06273',
    errorHover: '#e04d60',
    warning: '#ffb74d',
    warningHover: '#f5a732',
    info: '#03a9f4',
    infoHover: '#0288d1',
    // Utility grays
    gray: '#6b7280',
    lightGray: '#9ca3af',
    // Cluster/visualization colors
    clusterBg: '#f3f4f6',
    clusterStroke: '#d1d5db'
  },
  links: {
    nav: {
      color: 'inherit',
      '&.active': {
        color: 'primary'
      },
      '&:hover': {
        color: 'primary',
        borderBottom: '2px solid',
        borderBottomColor: 'primary'
      },
      textDecoration: 'none',
      fontSize: [2],
      fontWeight: 'bold',
      cursor: 'pointer',
      borderBottom: '2px solid',
      borderBottomColor: 'background'
    },
    activeNav: {
      color: 'inherit',
      '&.active': {
        color: 'primary'
      },
      '&:hover': {
        color: 'primary',
        borderBottomColor: 'primary'
      },
      textDecoration: 'none',
      fontSize: [2],
      fontWeight: 'bold',
      cursor: 'pointer',
      borderBottom: '2px solid',
      borderBottomColor: 'mediumGray'
    },
    header: {
      color: 'inherit',
      '&.active': {
        color: 'background'
      },
      '&:hover': {
        color: 'background'
      },
      textDecoration: 'none',
      fontSize: [2],
      fontWeight: 'bold',
      cursor: 'pointer'
    }
  },
  buttons: {
    primary: {
      color: 'background',
      bg: 'primary',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: 'none',
      '&:hover': {
        bg: 'infoHover'
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed'
      }
    },
    secondary: {
      color: 'text',
      bg: 'secondary',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: 'none',
      '&:hover': {
        bg: 'mediumGray',
        color: 'background'
      }
    },
    outline: {
      color: 'primary',
      bg: 'transparent',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: '2px solid',
      borderColor: 'primary',
      '&:hover': {
        bg: 'primary',
        color: 'background'
      }
    },
    success: {
      color: 'background',
      bg: 'success',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: 'none',
      '&:hover': {
        bg: 'successHover'
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed'
      }
    },
    danger: {
      color: 'background',
      bg: 'error',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: 'none',
      '&:hover': {
        bg: 'errorHover'
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed'
      }
    },
    warning: {
      color: 'background',
      bg: 'warning',
      fontFamily: 'body',
      cursor: 'pointer',
      borderRadius: 'default',
      border: 'none',
      '&:hover': {
        bg: 'warningHover'
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed'
      }
    }
  },
  cards: {
    primary: {
      backgroundColor: 'background',
      color: 'mediumGray',
      padding: 3,
      borderRadius: 'default',
      boxShadow: 'default',
      transition: 'all 0.2s ease',
      '&:hover': {
        boxShadow: 'md'
      }
    },
    compact: {
      backgroundColor: 'background',
      color: 'text',
      padding: 2,
      borderRadius: 'sm',
      boxShadow: 'sm',
      border: '1px solid',
      borderColor: 'border'
    }
  },
  text: {
    default: {
      color: 'text',
      fontFamily: 'body'
    },
    small: {
      fontSize: 0,
      color: 'textSecondary'
    },
    caps: {
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      fontSize: 0,
      fontWeight: 'bold'
    },
    heading: {
      fontFamily: 'heading',
      fontWeight: 'heading',
      lineHeight: 'heading'
    }
  },
  styles: {
    root: {
      fontFamily: 'body',
      lineHeight: 'body',
      fontWeight: 'body',
      boxSizing: 'border-box',
      // Prevent horizontal scroll on mobile
      overflowX: 'hidden',
      width: '100%',
      // Ensure all children inherit box-sizing
      '*, *::before, *::after': {
        boxSizing: 'border-box'
      }
    },
    a: {
      color: 'primary',
      '&:active': {
        color: 'primary'
      },
      '&:hover': {
        color: 'primary',
        borderBottom: 'solid',
        borderWidth: 2,
        borderColor: 'primary'
      },
      textDecoration: 'none',
      fontWeight: 'bold',
      cursor: 'pointer',
      borderBottom: 'solid',
      borderWidth: 2,
      borderColor: 'background'
    },
    // Ensure form elements respect viewport width
    input: {
      maxWidth: '100%',
      boxSizing: 'border-box'
    },
    textarea: {
      maxWidth: '100%',
      boxSizing: 'border-box'
    },
    select: {
      maxWidth: '100%',
      boxSizing: 'border-box'
    },
    // Prevent text from overflowing
    p: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h1: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h2: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h3: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h4: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h5: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    h6: {
      wordWrap: 'break-word',
      overflowWrap: 'break-word'
    },
    // Better checkbox and label handling
    label: {
      display: 'inline-flex',
      alignItems: 'flex-start',
      gap: 2,
      wordWrap: 'break-word',
      overflowWrap: 'break-word',
      maxWidth: '100%'
    }
  }
}
