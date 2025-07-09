import { logout } from '../../support/auth-helpers.js'

describe('Client Admin: Public Pages', () => {
  beforeEach(() => {
    // Ensure we're logged out to test public access
    logout()
    cy.clearAllLocalStorage()
    cy.clearAllSessionStorage()
  })

  describe('Home Page', () => {
    it('should display the home page at / when not authenticated', () => {
      cy.visit('/')

      // When not authenticated, should see landing page or redirect to signin
      cy.url().should('satisfy', (url) => {
        return url === '/' || url.includes('/signin') || url.includes('/createuser')
      })

      // Check for expected home page elements
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text()
        return (
          text.includes('Polis') ||
          text.includes('Sign in') ||
          text.includes('Create account') ||
          text.includes('Welcome')
        )
      })

      cy.log('✅ Home page accessible at /')
    })

    it('should have proper navigation links on home page', () => {
      cy.visit('/')

      // Check for footer links to privacy and terms
      // The footer uses relative href links without leading slash
      cy.get('a[href="privacy"], a[href="tos"]').should('exist')

      cy.log('✅ Privacy and Terms links found in footer')
    })
  })

  describe('Privacy Policy Page', () => {
    it('should display the privacy policy at /privacy', () => {
      cy.visit('/privacy')

      // Should be on privacy page
      cy.url().should('include', '/privacy')

      // Should see privacy policy content
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text().toLowerCase()
        return (
          text.includes('privacy') &&
          (text.includes('policy') ||
            text.includes('data') ||
            text.includes('information') ||
            text.includes('collect'))
        )
      })

      // Should have proper heading
      cy.get('h1, h2, h3').should('satisfy', ($headings) => {
        const headingTexts = Array.from($headings).map((h) => h.textContent?.toLowerCase() || '')
        return headingTexts.some((text) => text.includes('privacy'))
      })

      cy.log('✅ Privacy policy page accessible at /privacy')
    })

    it('should have navigation back to home from privacy page', () => {
      cy.visit('/privacy')

      // The header has a home link that goes to /home
      cy.get('a[href="/home"], a').contains('Polis').should('exist')

      // Click the Polis logo/text link to go home
      cy.get('a').contains('Polis').first().click()

      // Should navigate to /home
      cy.url().should('include', '/home')

      cy.log('✅ Can navigate from privacy page back to home')
    })
  })

  describe('Terms of Service Page', () => {
    it('should display the terms of service at /tos', () => {
      cy.visit('/tos')

      // Should be on terms page
      cy.url().should('include', '/tos')

      // Should see terms of service content
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text().toLowerCase()
        return (
          text.includes('terms') &&
          (text.includes('service') ||
            text.includes('use') ||
            text.includes('agreement') ||
            text.includes('conditions'))
        )
      })

      // Should have proper heading
      cy.get('h1, h2, h3').should('satisfy', ($headings) => {
        const headingTexts = Array.from($headings).map((h) => h.textContent?.toLowerCase() || '')
        return headingTexts.some((text) => text.includes('terms'))
      })

      cy.log('✅ Terms of service page accessible at /tos')
    })

    it('should have navigation back to home from terms page', () => {
      cy.visit('/tos')

      // The header has a home link that goes to /home
      cy.get('a[href="/home"], a').contains('Polis').should('exist')

      // Click the Polis logo/text link to go home
      cy.get('a').contains('Polis').first().click()

      // Should navigate to /home
      cy.url().should('include', '/home')

      cy.log('✅ Can navigate from terms page back to home')
    })
  })

  describe('Public Page Accessibility', () => {
    it('should allow access to public pages without authentication', () => {
      // Ensure we're not authenticated
      cy.clearAllLocalStorage()
      cy.clearAllSessionStorage()

      // Test that all public pages are accessible
      const publicPages = ['/', '/privacy', '/tos']

      publicPages.forEach((page) => {
        cy.visit(page)

        // Should not redirect to signin for public pages
        cy.url().should('satisfy', (url) => {
          // Allow signin redirect for home page, but not for privacy/tos
          if (page === '/') {
            return true // Home page might redirect to signin
          }
          return url.includes(page)
        })

        cy.log(`✅ Public page ${page} accessible without auth`)
      })
    })

    it('should maintain consistent layout across public pages', () => {
      const publicPages = ['/privacy', '/tos']

      publicPages.forEach((page) => {
        cy.visit(page)

        // Check for consistent layout elements from StaticLayout component
        // Should have header with Polis logo/link
        cy.get('a').contains('Polis').should('exist')

        // Should have Sign in link in header
        cy.get('a[href="/signin"]').should('exist')

        // Should have footer with Legal heading
        cy.get('h3').contains('Legal').should('exist')

        // Should have footer links
        cy.get('a[href="privacy"], a[href="tos"]').should('exist')

        cy.log(`✅ Page ${page} has consistent layout`)
      })
    })
  })

  describe('Page Structure', () => {
    it('should have consistent page title across all pages', () => {
      // The title is set in index.html as "Polis" and doesn't change per page
      const pages = ['/', '/privacy', '/tos']

      pages.forEach((path) => {
        cy.visit(path)
        cy.title().should('eq', 'Polis')
        cy.log(`✅ Page ${path} has title "Polis"`)
      })
    })

    it('should have proper footer content', () => {
      cy.visit('/privacy')

      // Check footer content based on lander-footer.js
      cy.get('body').should('contain.text', 'Legal')
      cy.get('body').should('contain.text', 'Polis is built for the public with')
      cy.get('body').should('contain.text', 'The Authors')

      // Check footer links
      cy.get('a[href="tos"]').should('contain.text', 'TOS')
      cy.get('a[href="privacy"]').should('contain.text', 'Privacy')

      cy.log('✅ Footer has proper content and links')
    })

    it('should have viewport meta tag for responsive design', () => {
      cy.visit('/')

      // Check for viewport meta tag (may be modified by webpack/build process)
      cy.get('meta[name="viewport"]')
        .should('have.attr', 'content')
        .and('match', /width=device-width,?\s?initial-scale=1(\.0)?/)

      cy.log('✅ Viewport meta tag present for responsive design')
    })
  })
})
