export default {
  space: [0, 4, 8, 16, 32, 64, 128, 256, 512],
  fonts: {
    body:
      // 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      // "'Space Mono', monospace",
      "'Helvetica Neue'",
    heading: 'inherit',
    monospace: "'Space Mono', monospace"
  },
  fontSizes: [12, 14, 16, 18, 24, 36, 48, 64, 96],
  fontWeights: {
    body: 400,
    heading: 700,
    bold: 700
  },
  text: {
    conversationPage: {
      fontFamily: "Times New Roman",
      fontStyle: "italic",
    },
  },
  borders: {
    primary: {
      border: "solid 1px lightGray",
      borderRadius: "5px"
    },
    avatar: {
      border: "solid 1px lightGray",
      borderRadius: "2px"
    }
  },
  statementBox: {
    variant: "borders.primary",
    bg: "white",
    stack: {
      variant: "borders.primary",
      bg: "white",
      marginBottom: "10px",
      minHeight: "30px",
      margin: "0 auto",
      position: "relative",
    },
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
    text: '#000000',
    // background: "#03a9f4",
    // primary: "#FFF",
    background: '#FFF',
    primary: '#cf5e00',
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
      fontWeight: '500',
      cursor: 'pointer',
    },
    vote: {
      color: 'text',
      bg: 'transparent',
      fontWeight: '400',
      fontSize: [1],
      cursor: 'pointer',
      transition: 'all .2s ease-in-out',
      '&:hover': {
        transform: 'scale(1.12,1.12)'
      },
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
