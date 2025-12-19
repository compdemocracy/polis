/**
 * Alpha client voting flow
 *
 * Creates a conversation with 3 comments, then votes Agree/Disagree/Pass.
 * When no more statements remain, the EmailSubscribeForm should be shown.
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: Voting', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Alpha voting flow',
      description: 'E2E: vote Agree/Disagree/Pass and reach end-state',
      comments: ['Vote test comment 1', 'Vote test comment 2', 'Vote test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('can vote agree, disagree, pass; shows email subscribe when exhausted', function () {
    cy.clearAllLocalStorage()

    // Hydration signal: Survey.tsx triggers GET /api/v3/nextComment in a useEffect().
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment')
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote')

    cy.visit(`/alpha/${conversationId}`)

    cy.get('[data-testid="vote-agree"]').should('be.visible')
    cy.wait('@nextComment')

    // 1) Agree
    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote').its('response.statusCode').should('eq', 200)

    // 2) Disagree
    cy.get('[data-testid="vote-disagree"]').should('be.visible').click()
    cy.wait('@vote').its('response.statusCode').should('eq', 200)

    // 3) Pass
    cy.get('[data-testid="vote-pass"]').should('be.visible').click()
    cy.wait('@vote').its('response.statusCode').should('eq', 200)

    // End-state: when no statements remain, Survey renders EmailSubscribeForm.
    // IMPORTANT: We expect exhaustion after exactly 3 votes (since we seeded 3 comments).
    // If the app shows another statement (vote buttons still present), that's a bug and should fail.
    cy.get('.email-subscribe-container').should('be.visible')
    cy.get('.email-subscribe-container input[type="email"]').should('be.visible')

    cy.get('[data-testid="vote-agree"]').should('not.exist')
    cy.get('[data-testid="vote-disagree"]').should('not.exist')
    cy.get('[data-testid="vote-pass"]').should('not.exist')
  })
})
