/**
 * Alpha client accessibility smoke (cypress-axe)
 *
 * Checks critical/serious axe violations on the participation voting UI.
 * Uses a known conversation so setup does not depend on admin OIDC login.
 *
 * Override with CYPRESS_A11Y_CONVERSATION_ID if needed.
 */

describe('Alpha Client: Accessibility smoke', function () {
  const conversationId = Cypress.env('A11Y_CONVERSATION_ID') || '52czbnk3jn'

  beforeEach(function () {
    cy.clearAllLocalStorage()
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment')
    cy.visit(`/alpha/${conversationId}`)
  })

  it('has no critical or serious axe violations on the statement voting card', function () {
    cy.get('[data-testid="vote-agree"]', { timeout: 15000 }).should('be.visible')
    cy.wait('@nextComment')

    cy.injectAxe()
    cy.checkA11y('.statement-card', {
      includedImpacts: ['critical', 'serious'],
    })
  })

  it('has no critical or serious axe violations on the comment submission form', function () {
    cy.get('.submit-form', { timeout: 15000 }).should('be.visible')

    cy.injectAxe()
    cy.checkA11y('.submit-form', {
      includedImpacts: ['critical', 'serious'],
    })
  })
})
