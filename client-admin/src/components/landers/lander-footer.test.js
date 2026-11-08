import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Footer from './lander-footer'

describe('lander footer', () => {
  it('credits the Twemoji graphics and links their licence', () => {
    render(
      <ThemeUIProvider theme={theme}>
        <Footer />
      </ThemeUIProvider>
    )
    expect(screen.getByAltText('❤️')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Twemoji' })).toHaveAttribute(
      'href',
      'https://github.com/twitter/twemoji'
    )
    expect(screen.getByRole('link', { name: 'CC-BY 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/'
    )
    expect(screen.getByText(/Twitter, Inc and other contributors/)).toBeInTheDocument()
  })
})
