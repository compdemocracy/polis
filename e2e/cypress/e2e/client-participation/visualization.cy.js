const participationView = '[data-view-name="participationView"]'
const timeout = { timeout: 20000 }

describe('Visualization', function () {
  before(function () {
    cy.createConvo().then(() => {
      cy.seedComment(this.convoId)
      cy.seedComment(this.convoId)
      cy.seedComment(this.convoId)

      cy.visit('/m/' + this.convoId)
      cy.get('input[data-test-id="vis_type"]').check()

      cy.initAndVote('participant', this.convoId)
      cy.initAndVote('participant2', this.convoId)
      cy.initAndVote('participant3', this.convoId)
      cy.initAndVote('participant4', this.convoId)
      cy.initAndVote('participant5', this.convoId)
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

  // Possible bug: the visualization is in limbo after 6 participants,
  // but it shows properly after 7 participants.
  it('shows the visualization after 7 participants', function () {
    cy.initAndVote('participant6', this.convoId)
    cy.initAndVote('participant7', this.convoId)
    cy.wait('@getMath').its('response.statusCode').should('eq', 200)
    cy.wait('@getFamous')

    cy.get(participationView).find('#vis_section', timeout).should('be.visible')
    cy.get(participationView).find('#vis_help_label', timeout).should('be.visible')
    cy.get(participationView).find('#vis_not_yet_label', timeout).should('not.be.visible')
  })
})
