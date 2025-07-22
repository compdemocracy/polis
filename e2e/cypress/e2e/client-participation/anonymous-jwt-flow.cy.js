/**
 * Test for anonymous participation JWT flow
 * Verifies that anonymous participants receive JWT tokens when they vote
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Anonymous Participation JWT Flow', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Test Anonymous JWT Flow',
      description: 'Testing anonymous participation with JWT',
      comments: ['Test comment 1', 'Test comment 2', 'Test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('should issue JWT on first vote for anonymous participant', function () {
    // Clear storage
    cy.clearLocalStorage()

    cy.visit(`/${conversationId}`)

    // Wait for page to load
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // Intercept the vote request
    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        expect(res.body.auth.token).to.exist
        expect(res.statusCode).to.eq(200)
        expect(res.body.currentPid).to.exist
      })
    }).as('vote')

    // Intercept ALL subsequent requests to track JWT
    cy.intercept('**/api/v3/**', (req) => {
      // Skip if it's the vote POST we already intercepted
      if (req.method === 'POST' && req.url.includes('/votes')) {
        return
      }
    })

    // Click vote button
    cy.get('#agreeButton').click()

    // Wait for vote
    cy.wait('@vote')

    // Check localStorage
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist', { timeout: 10000 })
      .then((token) => {
        // Verify JWT format
        const parts = token.split('.')
        expect(parts).to.have.length(3)

        // Decode payload
        const payload = JSON.parse(atob(parts[1]))
        expect(payload.anonymous_participant).to.be.true
        expect(payload.sub).to.match(/^anon:/)
      })
  })

  it('should persist JWT across page reloads', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Visit and vote
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')
    cy.get('#agreeButton').click()

    // Wait for JWT to be stored using should assertion for retry
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
      .then((token) => {
        // Reload
        cy.reload()

        // Check persistence
        cy.window().then((newWin) => {
          const persistedToken = newWin.localStorage.getItem(`participant_token_${conversationId}`)
          expect(persistedToken).to.equal(token)
          console.log('✅ JWT persisted across reload')
        })
      })
  })
})
