/**
 * Alpha client: Treevite (invite codes) gating
 *
 * This feature is new (no legacy test).
 * Assertions focus on participant UI gating only:
 * - When treevite is enabled, invite/login code form is shown
 * - Voting is blocked until invite-code or login-code auth
 * - Commenting is blocked until invite-code or login-code auth
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: Invite codes (Treevite)', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Alpha Treevite gating',
      description: 'Treevite enabled: participants must enter invite/login code',
      treeviteEnabled: true,
      comments: ['Seed statement 1', 'Seed statement 2', 'Seed statement 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created (treevite enabled): ${conversationId}`)
    })
  })

  beforeEach(function () {
    cy.clearAllLocalStorage()
  })

  it('shows invite code submission form and blocks voting + commenting', function () {
    cy.visit(`/alpha/${conversationId}`)

    // Invite gate visible
    cy.get('.invite-code-submission-form').should('be.visible')
    cy.get('.invite-code-submission-form-container input[type="text"]').should('have.length', 2)

    // Buttons should be disabled until codes are entered
    cy.get('.invite-code-submission-form-container button').first().should('be.disabled')
    cy.get('.invite-code-submission-form-container button').last().should('be.disabled')

    // Voting UI should not be available
    cy.get('[data-testid="vote-agree"]').should('not.exist')
    cy.get('[data-testid="vote-disagree"]').should('not.exist')
    cy.get('[data-testid="vote-pass"]').should('not.exist')

    // Comment submission UI should not be available
    cy.get('.submit-form').should('not.exist')
    cy.get('.submit-form textarea').should('not.exist')
  })
})
