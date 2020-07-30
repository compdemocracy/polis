export default {
  space: [0, 4, 8, 16, 32, 64, 128, 256, 512],
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
    maxWidth: {
      paragraph: '35em' // right syntax? https://theme-ui.com/theme-spec
    }
  },
  lineHeights: {
    body: 1.5,
    heading: 1.125
  },
  colors: {
    // text: "#FFF",
    text: '#60656F',
    // background: "#03a9f4",
    // primary: "#FFF",
    background: '#FFF',
    primary: '#03a9f4',
    secondary: '#F6F7F8',
    mediumGray: '#60656F'
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
      cursor: 'pointer'
    }
  },
  cards: {
    primary: {
      backgroundColor: 'background',
      color: 'mediumGray',
      padding: 3,
      borderRadius: 4,
      boxShadow: '0 0 8px rgba(0, 0, 0, 0.125)'
    }
  },
  styles: {
    root: {
      fontFamily: 'body',
      lineHeight: 'body',
      fontWeight: 'body'
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
    }
  }
}
