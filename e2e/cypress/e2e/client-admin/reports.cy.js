describe('Reports', function () {
  beforeEach(function () {
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/reports*').as('getReports')
    cy.intercept('GET', '/api/v3/comments*').as('getComments')

    cy.createConvo().then(() => {
      cy.visit('/m/' + this.convoId)
      cy.wait('@getConversations')
      cy.visit('/m/' + this.convoId + '/reports')
    })
  })

  describe('Reports List', function () {
    it('should create a report URL and show link', function () {
      // pause for ten seconds to allow the button to be visible
      cy.pause()
      cy.contains('button', 'Create report url').click()
      cy.get('a').should('exist')
    })
  })
})
