import { loginStandardUser, loginStandardUserAPI, logout } from '../../support/auth-helpers.js'

import { createTestConversationAPI } from '../../support/conversation-helpers.js'

describe('Client Admin: Routes', () => {
  let testConversationId

  before(() => {
    cy.log('🔧 Setting up test conversation for route tests')

    // Phase 1: Admin setup (isolated window context)
    cy.window().then(() => {
      // Use API authentication for reliable setup
      loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        cy.log('✅ Admin authenticated via API')

        // Create test conversation using API helper
        return createTestConversationAPI({
          topic: 'Route Testing Conversation',
          description: 'Used for testing client-admin routes',
        }).then((conversationId) => {
          testConversationId = conversationId
          cy.log(`✅ Created test conversation: ${testConversationId}`)
        })
      })
    })

    // Clean logout after setup to prevent sticky auth
    cy.then(() => {
      logout()
      cy.log('🧹 Setup complete - authentication cleared')
    })
  })

  describe('Authentication Routes', () => {
    beforeEach(() => {
      // Ensure clean state for each authentication test
      logout()
    })

    it('should display sign in page at /signin', () => {
      cy.visit('/signin')

      // Should see sign in form or OIDC redirect
      cy.url().should('satisfy', (url) => {
        return url.includes('/signin') || url.includes('authorize')
      })

      cy.log('✅ Sign in page accessible at /signin')
    })

    it('should sign out when visiting /signout', () => {
      // First ensure we're logged in using UI auth (needed for UI signout test)
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      // Visit signout route
      cy.visit('/signout')

      // Should be logged out and redirected
      cy.url().should('include', '/home')

      // Verify we're actually logged out by trying to access admin page
      cy.visit(`/m/${testConversationId}`, { failOnStatusCode: false })
      cy.url().should('not.include', `/m/${testConversationId}`)

      cy.log('✅ Signout route successfully logs out user')
    })
  })

  describe('Main Admin Routes', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should display all conversations page at /', () => {
      cy.visit('/')

      // Should see conversations list
      cy.get('h3').should('contain.text', 'All Conversations')

      // Should see our test conversation in the list
      cy.get('body').should('contain.text', 'Route Testing Conversation')

      cy.log('✅ All conversations page accessible at /')
    })

    it('should display integrate page at /integrate', () => {
      cy.visit('/integrate')

      // Should see integrate page content
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text()
        return text.includes('Integrate') || text.includes('Integration') || text.includes('API')
      })

      cy.log('✅ Integrate page accessible at /integrate')
    })

    it('should display account page at /account', () => {
      cy.visit('/account')

      // Should see account page with user info
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text()
        return (
          text.includes('Account') || text.includes('admin@polis.test') || text.includes('Profile')
        )
      })

      cy.log('✅ Account page accessible at /account')
    })
  })

  describe('Conversation-Specific Routes', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should display conversation configure page at /m/:id', () => {
      cy.visit(`/m/${testConversationId}`)

      // Should see configuration interface
      cy.get('h1, h2, h3').should('contain.text', 'Configure')
      cy.get('input[data-testid="topic"], input[id*="topic"]').should('be.visible')

      cy.log(`✅ Configure page accessible at /m/${testConversationId}`)
    })

    it('should display conversation distribute page at /m/:id/share', () => {
      cy.visit(`/m/${testConversationId}/share`)

      // Should see distribute/share interface
      cy.get('h1, h2, h3').should('contain.text', 'Distribute')
      cy.get('body').should('contain.text', 'Share')

      cy.log(`✅ Distribute page accessible at /m/${testConversationId}/share`)
    })

    it('should display conversation moderate page at /m/:id/comments', () => {
      cy.visit(`/m/${testConversationId}/comments`)

      // Should see moderation interface
      cy.get('h1, h2, h3, body').should('contain.text', 'Moderate')

      cy.log(`✅ Moderate page accessible at /m/${testConversationId}/comments`)
    })

    it('should display accepted comments page at /m/:id/comments/accepted', () => {
      cy.visit(`/m/${testConversationId}/comments/accepted`)

      // Should be on comments page with accepted filter
      cy.url().should('include', 'accepted')
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text()
        return text.includes('Accepted') || text.includes('Approved') || text.includes('Moderate')
      })

      cy.log(`✅ Accepted comments page accessible at /m/${testConversationId}/comments/accepted`)
    })

    it('should display rejected comments page at /m/:id/comments/rejected', () => {
      cy.visit(`/m/${testConversationId}/comments/rejected`)

      // Should be on comments page with rejected filter
      cy.url().should('include', 'rejected')
      cy.get('body').should('satisfy', ($body) => {
        const text = $body.text()
        return text.includes('Rejected') || text.includes('Trash') || text.includes('Moderate')
      })

      cy.log(`✅ Rejected comments page accessible at /m/${testConversationId}/comments/rejected`)
    })

    it('should display conversation monitor page at /m/:id/stats', () => {
      cy.visit(`/m/${testConversationId}/stats`)

      // Should see monitoring/stats interface
      cy.get('h1, h2, h3, body').should('contain.text', 'Monitor')

      cy.log(`✅ Monitor page accessible at /m/${testConversationId}/stats`)
    })

    it('should display conversation reports page at /m/:id/reports', () => {
      cy.visit(`/m/${testConversationId}/reports`)

      // Should see reports interface
      cy.get('h1, h2, h3, body').should('contain.text', 'Report')

      cy.log(`✅ Reports page accessible at /m/${testConversationId}/reports`)
    })
  })

  describe('Route Navigation', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should maintain authentication across route navigation', () => {
      // Visit multiple routes in sequence
      const routes = [
        '/',
        `/m/${testConversationId}`,
        `/m/${testConversationId}/share`,
        `/m/${testConversationId}/comments`,
        `/m/${testConversationId}/stats`,
        `/m/${testConversationId}/reports`,
        '/account',
        '/integrate',
      ]

      routes.forEach((route) => {
        cy.visit(route)
        // Should not be redirected to signin
        cy.url().should('not.include', '/signin')
        cy.log(`✅ Maintained auth at ${route}`)
      })
    })

    it('should handle invalid conversation IDs gracefully', () => {
      const invalidId = 'invalid123'

      // Try various routes with invalid ID
      const invalidRoutes = [
        `/m/${invalidId}`,
        `/m/${invalidId}/share`,
        `/m/${invalidId}/comments`,
        `/m/${invalidId}/stats`,
        `/m/${invalidId}/reports`,
      ]

      invalidRoutes.forEach((route) => {
        cy.visit(route, { failOnStatusCode: false })

        // Should either show error message, redirect, or display error page
        cy.get('body').should('satisfy', ($body) => {
          const text = $body.text()
          const url = window.location.href

          return (
            // Shows "Cannot GET" error message
            text.includes('Cannot GET') ||
            // Or redirected away from invalid ID
            !url.includes(invalidId) ||
            // Or redirected to home
            url.endsWith('/')
          )
        })

        cy.log(`✅ Invalid route ${route} handled gracefully`)
      })
    })
  })

  describe('Deep Linking', () => {
    it('should allow deep linking to specific conversation sections when authenticated', () => {
      logout()

      // Try to deep link to stats page
      const deepLink = `/m/${testConversationId}/stats`

      // Visit deep link while logged out
      cy.visit(deepLink, { failOnStatusCode: false })

      // Should redirect to signin
      cy.url().should('not.include', deepLink)

      // Now login
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      // Try deep link again
      cy.visit(deepLink)

      // Should successfully reach the deep linked page
      cy.url().should('include', deepLink)
      cy.get('h1, h2, h3, body').should('contain.text', 'Monitor')

      cy.log('✅ Deep linking works correctly with authentication')
    })
  })
})
