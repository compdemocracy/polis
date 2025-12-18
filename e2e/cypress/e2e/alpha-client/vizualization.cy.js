/**
 * Alpha client visualization tests
 *
 * Modeled after legacy `client-participation/visualization.cy.js`.
 *
 * Notes:
 * - Visualization depends on the math service (PCA) and can be flaky.
 * - This test intentionally uses multiple distinct participants (via XID) to exercise
 *   Cypress auth isolation and participant counting.
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: Visualization', function () {
  let conversationId

  const timeout = { timeout: 60000 }

  before(function () {
    setupTestConversation({
      topic: 'Alpha Visualization E2E',
      description: 'Testing alpha visualization with multiple distinct participants',
      visualizationEnabled: true,
      comments: ['Seed statement 1', 'Seed statement 2', 'Seed statement 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created (vis enabled): ${conversationId}`)
    })
  })

  const createParticipantAndVoteAll = (index) => {
    const xid = `alpha-viz-${Date.now()}-${index}`

    // Ensure each participant is isolated
    cy.clearAllLocalStorage()

    // Hydration signal (React island fetches next comment)
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as(`nextComment_${index}`)
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as(`vote_${index}`)

    cy.visit(`/alpha/${conversationId}?xid=${encodeURIComponent(xid)}`)

    // Wait for voting UI + hydration to finish attaching handlers
    cy.get('[data-testid="vote-agree"]', { timeout: 20000 }).should('be.visible')
    cy.wait(`@nextComment_${index}`)

    // Vote 3 times (vary vote types for more interesting PCA)
    cy.get('[data-testid="vote-agree"]').click({ force: true })
    cy.wait(`@vote_${index}`).its('response.statusCode').should('eq', 200)

    cy.get('[data-testid="vote-disagree"]').should('be.visible').click({ force: true })
    cy.wait(`@vote_${index}`).its('response.statusCode').should('eq', 200)

    cy.get('[data-testid="vote-pass"]').should('be.visible').click({ force: true })
    cy.wait(`@vote_${index}`).its('response.statusCode').should('eq', 200)

    // After exhausting 3 seeded comments, end-state should be shown
    cy.get('.email-subscribe-container', { timeout: 20000 }).should('be.visible')

    return cy.wrap(xid)
  }

  it('shows the PCA visualization after 7+ distinct participants vote', function () {
    const participantIndices = Array.from({ length: 7 }, (_, i) => i + 1)

    cy.log('🧪 Creating 7 distinct participants (XID)')

    // Create participants sequentially
    cy.wrap(participantIndices).each((i) => {
      createParticipantAndVoteAll(i)
    })

    // Trigger math computation (best-effort; may be a no-op in some envs)
    cy.request({
      method: 'GET',
      url: `/api/v3/mathUpdate?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    })

    // Verify participant count increased
    cy.request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    }).then((response) => {
      const count = response.body?.participant_count || 0
      cy.log(`📊 participant_count: ${count}`)
      expect(count).to.be.at.least(7)
    })

    // New viewer (clean state) loads visualization
    cy.clearAllLocalStorage()

    cy.intercept({ method: 'GET', url: '**/api/v3/math/pca2*' }).as('getMath')
    cy.intercept({ method: 'GET', url: '**/api/v3/comments*' }).as('getComments')

    cy.visit(`/alpha/${conversationId}?ui_lang=en`)

    // Wait for PCA + comments fetch
    cy.wait('@getMath', timeout)
    cy.wait('@getComments', timeout)

    // Assert visualization is present (DOM details can be tightened as we iterate)
    cy.get('.visualization-container', timeout).should('be.visible')
    cy.get('.visualization-container svg', timeout).should('exist')

    // PCAVisualization renders a section-card with an "Opinion Groups" heading
    cy.contains('h2', /opinion groups/i, timeout).should('be.visible')
  })
})
