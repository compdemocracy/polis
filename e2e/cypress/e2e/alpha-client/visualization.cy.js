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
    cy.get('[data-testid="vote-agree"]').should('be.visible')
      .should('be.visible')
      .and('not.be.disabled')
    cy.wait(`@nextComment_${index}`)

    // Ensure we have a participant token before voting, so subsequent votes are attributed
    // to the intended distinct participant (xid -> pid).
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')

    const waitForNextFromVoteResponse = (voteAlias, label) => {
      return cy.wait(voteAlias).then((interception) => {
        const status = interception.response?.statusCode
        expect(status, `${label} vote status`).to.eq(200)

        const body = interception.response?.body || {}
        const next = body.nextComment
        const nextTid = next?.tid
        const nextTxt = typeof next?.txt === 'string' ? next.txt.trim() : null

        // In the alpha client, Survey.tsx uses the vote response to set the next statement.
        // So the most deterministic wait is: either nextComment exists and becomes the DOM statement,
        // or nextComment is null/absent and we reach the end-state.
        if (!next || typeof nextTid === 'undefined' || !nextTxt) {
          cy.get('.email-subscribe-container').should('be.visible')
          return
        }

        // Wait until the rendered statement matches the nextComment text from the vote response.
        // Use bdi inner text so we avoid concatenating multiple elements.
        cy.get('.statement-card .statement-text bdi')
          .first()
          .should(($bdi) => {
            const rendered = ($bdi.text() || '').trim()
            expect(
              rendered,
              `${label} expected statement to match voteResponse.nextComment.txt`,
            ).to.eq(nextTxt)
          })
      })
    }

    cy.get('[data-testid="vote-agree"]').should('be.visible').and('not.be.disabled').click()
    waitForNextFromVoteResponse(`@vote_${index}`, `p${index}-agree`)

    cy.get('[data-testid="vote-disagree"]').should('be.visible').and('not.be.disabled').click()
    waitForNextFromVoteResponse(`@vote_${index}`, `p${index}-disagree`)

    cy.get('[data-testid="vote-pass"]').should('be.visible').and('not.be.disabled').click()
    waitForNextFromVoteResponse(`@vote_${index}`, `p${index}-pass`)

    // After exhausting 3 seeded comments, end-state should be shown
    cy.get('.email-subscribe-container').should('be.visible')

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
    cy.wait('@getMath')
    cy.wait('@getComments')

    // Assert visualization is present (DOM details can be tightened as we iterate)
    cy.get('.visualization-container').should('be.visible')
    cy.get('.visualization-container svg').should('exist')

    // PCAVisualization renders a section-card with an "Opinion Groups" heading
    cy.contains('h2', /opinion groups/i).should('be.visible')
  })
})
