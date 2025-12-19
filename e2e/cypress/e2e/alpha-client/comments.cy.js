/**
 * Alpha client comments (statement submission) flow
 *
 * Asserts:
 * - Participant can submit a comment (statement)
 * - Participant does NOT see their own comment while voting
 *   (after seeding 3 statements, submitting 1 more, voting should exhaust after 3)
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: Comments (statements)', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Alpha comment submission flow',
      description: 'E2E: submit statement and ensure it is excluded from own voting feed',
      comments: ['Seed statement 1', 'Seed statement 2', 'Seed statement 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('can submit a comment and does not see it when voting', function () {
    const submittedText = `e2e-submitted-${Date.now()}`

    cy.clearAllLocalStorage()

    // Hydration signal: Survey.tsx triggers GET /api/v3/nextComment in a useEffect().
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment')
    cy.intercept({ method: 'POST', url: '**/api/v3/comments*' }).as('submitComment')
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote')

    cy.visit(`/alpha/${conversationId}`)

    // Wait for voting UI and hydration
    cy.get('[data-testid="vote-agree"]').should('be.visible')
    cy.wait('@nextComment')

    // Submit a new statement
    cy.get('.submit-form textarea').should('be.visible')
    cy.get('.submit-form textarea').clear()
    cy.get('.submit-form textarea').type(submittedText)
    cy.get('.submit-form button[type="submit"]').should('be.enabled').click()

    // UI feedback should be shown (and textarea cleared)
    cy.get('.submit-form textarea').should('have.value', '')
    cy.contains('p', 'Statement submitted', { matchCase: false }).should('be.visible')

    // Ensure we have a participant token before voting, so votes are attributed to the same participant.
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')

    // Now vote 3 times (agree/disagree/pass). Each time, ensure we are NOT shown the submitted statement.
    cy.get('.statement-text').should('be.visible').should('not.contain', submittedText)
    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote')

    cy.get('.statement-text').should('be.visible').should('not.contain', submittedText)
    cy.get('[data-testid="vote-disagree"]').should('be.visible').click()
    cy.wait('@vote')

    cy.get('.statement-text').should('be.visible').should('not.contain', submittedText)
    cy.get('[data-testid="vote-pass"]').should('be.visible').click()
    cy.wait('@vote')

    // We seeded exactly 3 statements; participant should be exhausted after 3 votes.
    // If their newly submitted statement is incorrectly included in the feed, vote buttons will remain.
    cy.get('body').should(($body) => {
      const hasEmailSubscribe = $body.find('.email-subscribe-container').length > 0

      if (!hasEmailSubscribe) {
        expect(hasEmailSubscribe, 'Expected EmailSubscribeForm after 3 votes (seeded 3).').to.eq(
          true,
        )
      }

      expect(
        $body.find(
          '[data-testid="vote-agree"], [data-testid="vote-disagree"], [data-testid="vote-pass"]',
        ).length,
        'vote buttons should be gone once exhausted',
      ).to.eq(0)
    })

    cy.get('.email-subscribe-container input[type="email"]').should('be.visible')
  })
})
