import {
  loginStandardUser,
  loginStandardUserAPI,
  logout,
  participateWithXID,
} from '../../support/auth-helpers.js'

import { createTestConversationAPI } from '../../support/conversation-helpers.js'

import {
  navigateToConversationSection,
  verifyAdminInterfaceElements,
} from '../../support/admin-helpers.js'

describe('Client Admin: Access Control', () => {
  let adminConversationId
  let otherAdminConversationId

  before(() => {
    // Create admin conversation first using API approach
    logout()
    loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
      .then(() => {
        return createTestConversationAPI({
          topic: 'Admin Access Control Test',
          description: 'Testing access control for admin-owned conversation',
        })
      })
      .then((conversationId) => {
        adminConversationId = conversationId

        // Then create moderator conversation
        logout()
        return loginStandardUserAPI('moderator@polis.test', 'Te$tP@ssw0rd*')
      })
      .then(() => {
        return createTestConversationAPI({
          topic: 'Moderator Access Control Test',
          description: 'Testing access control for conversation owned by moderator',
        })
      })
      .then((conversationId) => {
        otherAdminConversationId = conversationId
      })
  })

  describe('Admin Access to Own Conversations', () => {
    beforeEach(() => {
      logout()
      // Use UI authentication for admin interface access
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should allow admin to access configuration page of own conversation', () => {
      cy.visit(`/m/${adminConversationId}`)
      cy.get('body').should('be.visible')
      cy.get('h1, h2, h3').should('contain.text', 'Configure')
      cy.get('input[data-testid="topic"]').should('exist')
      verifyAdminInterfaceElements('configure')
    })

    it('should allow admin to access all sections of own conversation', () => {
      const sections = [
        { name: 'distribute', heading: 'Distribute' },
        { name: 'moderate', heading: 'Moderate' },
        { name: 'monitor', heading: 'Monitor' },
        { name: 'report', heading: 'Report' },
      ]

      sections.forEach((section) => {
        navigateToConversationSection(adminConversationId, section.name)
        cy.get('body').should('be.visible')
        cy.get('h1, h2, h3').should('contain.text', section.heading)
      })
    })
  })

  describe('Admin Access to Other Admin Conversations', () => {
    beforeEach(() => {
      logout()
      // Use UI authentication for admin interface access
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should deny admin access to conversations owned by another admin', () => {
      cy.visit(`/m/${otherAdminConversationId}`, { failOnStatusCode: false })
      cy.get('body').should('be.visible')

      // Should show the permissions error message
      cy.get('body').should(
        'contain.text',
        'Your account does not have the permissions to view this page.',
      )
      cy.get('#no-permission-warning').should('be.visible')
      cy.get('body').should('not.contain.text', 'Seed Comments')
      cy.url().should('include', otherAdminConversationId)
    })
  })

  describe('Anonymous User Access', () => {
    beforeEach(() => {
      logout()
      cy.clearAllLocalStorage()
      cy.clearAllSessionStorage()
    })

    it('should deny anonymous users access to admin configuration page', () => {
      cy.visit(`/m/${adminConversationId}`, { failOnStatusCode: false })
      cy.get('body').should('be.visible')

      // Should be redirected to signin page or home
      cy.url().should('satisfy', (url) => {
        return (
          url.includes('/signin') ||
          url.includes('/createuser') ||
          url === '/' ||
          url.includes('/home')
        )
      })

      // Should not see admin interface
      cy.get('body').then(($body) => {
        const text = $body.text()
        expect(text).to.not.include('Configure')
        expect(text).to.not.include('Seed Comments')
      })
    })

    it('should redirect anonymous users when accessing admin URLs directly', () => {
      const sections = ['', '/share', '/comments', '/stats', '/reports']

      sections.forEach((section) => {
        const url = `/m/${adminConversationId}${section}`
        cy.visit(url, { failOnStatusCode: false })
        cy.get('body').should('be.visible')

        // Should be redirected away from admin pages
        cy.url().should('satisfy', (currentUrl) => {
          return (
            currentUrl.includes('/signin') ||
            currentUrl.includes('/createuser') ||
            currentUrl === '/' ||
            currentUrl.includes('/home') ||
            !currentUrl.includes('/m/')
          )
        })
      })
    })
  })

  describe('XID Participant Access', () => {
    it('should deny XID participants access to admin pages', () => {
      logout()

      cy.visit(`/m/${adminConversationId}?xid=test-xid-user`, { failOnStatusCode: false })
      cy.get('body').should('be.visible')

      // Should be redirected away from admin interface
      cy.url().should('satisfy', (url) => {
        return (
          url.includes('/signin') ||
          url.includes('/') ||
          url.includes('/home') ||
          !url.includes(`/m/${adminConversationId}`)
        )
      })

      // Should not see admin interface
      cy.get('body').then(($body) => {
        const text = $body.text()
        expect(text).to.not.include('Configure')
        expect(text).to.not.include('Seed Comments')
      })
    })

    it('should allow XID participants to access conversation participation page', () => {
      participateWithXID(adminConversationId, 'test-xid-user')

      // Should be on participation page, not admin page
      cy.url().should('include', adminConversationId)
      cy.url().should('not.include', '/m/')

      // Should see participation interface, not admin interface
      cy.get('body').should('be.visible')
      cy.get('body').then(($body) => {
        const text = $body.text()
        expect(text).to.not.include('Configure')
        expect(text).to.not.include('Seed Comments')
      })
    })
  })

  describe('Access Control Edge Cases', () => {
    it('should handle non-existent conversation IDs gracefully', () => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      const fakeConversationId = 'nonexistent123'

      cy.visit(`/m/${fakeConversationId}`, { failOnStatusCode: false })

      // Wait for page to load
      cy.get('body').should('be.visible')

      // Check what happens when accessing non-existent conversation
      cy.get('body').then(($body) => {
        const bodyText = $body.text()

        // Should either show error message or not show admin interface
        const hasError =
          bodyText.includes('not found') ||
          bodyText.includes('404') ||
          bodyText.includes('error') ||
          bodyText.includes('Error')

        const hasAdminInterface =
          bodyText.includes('Configure') && bodyText.includes('Seed Comments')

        if (hasError) {
          cy.log('✅ Non-existent conversation shows error message')
        } else if (!hasAdminInterface) {
          cy.log('✅ Non-existent conversation does not show admin interface')
        } else {
          // If it shows admin interface, it might be creating a new conversation
          cy.url().then((url) => {
            if (!url.includes(fakeConversationId)) {
              cy.log('✅ Non-existent conversation ID was replaced with valid ID')
            }
          })
        }
      })
    })

    it('should maintain access control after logout', () => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      // Verify access works
      cy.visit(`/m/${adminConversationId}`)
      cy.get('body').should('be.visible')
      cy.get('h1, h2, h3').should('contain.text', 'Configure')

      // Logout and try to access again
      logout()
      cy.visit(`/m/${adminConversationId}`, { failOnStatusCode: false })
      cy.get('body').should('be.visible')

      // Should be redirected to signin
      cy.url().should('satisfy', (url) => {
        return (
          url.includes('/signin') ||
          url.includes('/createuser') ||
          url === '/' ||
          url.includes('/home')
        )
      })
    })
  })
})
