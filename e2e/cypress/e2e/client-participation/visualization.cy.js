const participationView = '[data-view-name="participationView"]'
const timeout = { timeout: 20000 }

// Note: This test is flaky because it depends on an external math service.
// It might fail intermittently even when the code is working correctly.
describe('Visualization', function () {
  before(function () {
    cy.createConvo(undefined, undefined, 'admin').then(() => {
      cy.seedComment(this.convoId)
      cy.seedComment(this.convoId)
      cy.seedComment(this.convoId)

      cy.visit('/m/' + this.convoId)
      cy.get('input[data-test-id="vis_type"]').check()

      // Set up 5 participants to vote on the conversation
      const participants = [
        'participant',
        'participant2',
        'participant3',
        'participant4',
        'participant5',
      ]
      participants.forEach((participant) => {
        cy.ensureUser(participant)
        cy.voteOnConversation(this.convoId)
      })
    })
  })

  beforeEach(function () {
    cy.intercept('POST', '/api/v3/comments').as('postComment')
    cy.intercept('GET', '/api/v3/votes/famous*').as('getFamous')
    cy.intercept('GET', '/api/v3/math/pca2*').as('getMath')
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  it('does not show the visualization after 5 participants', function () {
    cy.ensureUser('participant5')
    cy.visit('/' + this.convoId)
    cy.wait('@participationInit')
    cy.wait('@getMath')

    cy.get(participationView).find('#vis_section', timeout).should('not.be.visible')
    cy.get(participationView).find('#vis_help_label', timeout).should('not.be.visible')
    cy.get(participationView).find('#vis_not_yet_label', timeout).should('be.visible')
  })

  it('shows the visualization after 7 participants', function () {
    // Add two more participants
    cy.ensureUser('participant6')
    cy.voteOnConversation(this.convoId)

    cy.ensureUser('participant7')
    cy.voteOnConversation(this.convoId)

    cy.wait('@getMath').its('response.statusCode').should('eq', 200)
    cy.wait('@getFamous')

    cy.get(participationView).find('#vis_section', timeout).should('be.visible')
    cy.get(participationView).find('#vis_help_label', timeout).should('be.visible')
    cy.get(participationView).find('#vis_not_yet_label', timeout).should('not.be.visible')
  })
})
