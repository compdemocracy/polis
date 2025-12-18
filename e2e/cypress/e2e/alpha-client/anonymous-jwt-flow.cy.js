/**
 * Test for anonymous participation JWT flow (alpha client)
 * Verifies that anonymous participants receive JWT tokens when they vote
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: Anonymous Participation JWT Flow', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Test Anonymous JWT Flow (alpha)',
      description: 'Testing anonymous participation with JWT (alpha client)',
      comments: ['Test comment 1', 'Test comment 2', 'Test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('should issue JWT on first vote for anonymous participant', function () {
    cy.clearLocalStorage()

    // Hydration signal: Survey.tsx triggers GET /api/v3/nextComment in a useEffect()
    // Waiting for this ensures the React click handler is attached (SSR markup alone is not enough).
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment')

    cy.visit(`/alpha/${conversationId}`)

    // Wait for page + voting UI
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    // Wait for hydration-driven request so clicks actually trigger handlers.
    cy.wait('@nextComment')

    // Vote request (match absolute or relative URL)
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote')

    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
      expect(interception.response?.body).to.have.nested.property('auth.token')
      expect(interception.response?.body.currentPid).to.exist
    })

    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
      .then((token) => {
        const parts = token.split('.')
        expect(parts).to.have.length(3)

        // decode via browser window for reliability
        cy.window().then((win) => {
          const payload = JSON.parse(win.atob(parts[1]))
          expect(payload.anonymous_participant).to.be.true
          expect(payload.sub).to.match(/^anon:/)
        })
      })
  })

  it('should persist JWT across page reloads', function () {
    cy.clearLocalStorage()

    // The SSR page can re-render during hydration when the client fetches
    // personalized state. Wait for that network signal before clicking to avoid detached DOM.
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment1')
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote1')

    cy.visit(`/alpha/${conversationId}`)
    cy.get('[data-testid="vote-agree"]').should('be.visible')
    cy.wait('@nextComment1')

    // Force-click to bypass Cypress actionability checks during brief React re-renders.
    cy.get('[data-testid="vote-agree"]').click({ force: true })
    cy.wait('@vote1').its('response.statusCode').should('eq', 200)

    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
      .then((token) => {
        // Reload triggers hydration + nextComment again, so wait for it to settle.
        cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment2')
        cy.reload()
        cy.wait('@nextComment2')

        cy.window().then((win) => {
          const persisted = win.localStorage.getItem(`participant_token_${conversationId}`)
          expect(persisted).to.equal(token)
        })
      })
  })
})
