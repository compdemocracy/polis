/**
 * Simple test to debug JWT flow
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'
import { logout } from '../../support/auth-helpers.js'

describe('Simple JWT Debug', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Simple JWT Test',
      description: 'Simple test',
      comments: ['Test comment', 'Another comment'],
    }).then((result) => {
      conversationId = result.conversationId
    })

    logout()
  })

  it('logs vote with minimal intercept', function () {
    cy.clearLocalStorage()

    // Simple intercept to wait for the API call
    // Intercept the vote request
    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        expect(res.body.auth.token).to.exist
        expect(res.statusCode).to.eq(200)
        expect(res.body.currentPid).to.exist
      })
    }).as('vote')

    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')
    cy.get('#agreeButton').click()

    // Wait for vote API to complete
    cy.wait('@vote')

    // Check localStorage
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist', { timeout: 10000 })
  })
})
