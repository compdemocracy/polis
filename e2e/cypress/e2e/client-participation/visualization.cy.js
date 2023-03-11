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
      cy.initAndVote('participant6', this.convoId)
    })
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
    cy.intercept('GET', '/api/v3/math/pca2*').as('getMath')
  })

  it('does not show the visualization before 7 participants', function () {
    cy.ensureUser('participant6')
    cy.visit('/' + this.convoId)
    cy.wait('@participationInit')
    cy.wait('@getMath')

    cy.get(participationView).find('#vis_help_label', timeout).should('not.be.visible')
    cy.get(participationView).find('#vis_not_yet_label', timeout).should('be.visible')
    cy.get(participationView).find('#vis_section', timeout).should('not.be.visible')
  })

  it('shows the visualization after 7 participants', function () {
    cy.initAndVote('participant7', this.convoId)
    cy.wait('@getMath')

    cy.get(participationView).find('#vis_help_label', timeout).should('be.visible')
    cy.get(participationView).find('#vis_not_yet_label', timeout).should('not.be.visible')
    cy.get(participationView).find('#vis_section', timeout).should('be.visible')
  })
})
