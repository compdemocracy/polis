describe('Access control', function () {
  before(function () {
    cy.ensureConversation().then(() => {
      cy.wrap('m/' + this.convoId).as('adminPath')
    })
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  describe('Participant', function () {
    beforeEach(function () {
      cy.ensureUser()
    })

    it('Cannot access /m/:id', function () {
      cy.visit(this.adminPath)
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Cannot access /m/:id/share', function () {
      cy.visit(this.adminPath + '/share')
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Cannot access /m/:id/comments', function () {
      cy.visit(this.adminPath + '/comments')
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Cannot access /m/:id/comments/rejected', function () {
      cy.visit(this.adminPath + '/comments/rejected')
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Cannot access /m/:id/stats', function () {
      cy.visit(this.adminPath + '/stats')
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Cannot access /m/:id/reports', function () {
      cy.visit(this.adminPath + '/reports')
      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Can access /:id', function () {
      cy.visit('/' + this.convoId)
      cy.wait('@participationInit').its('response.statusCode').should('eq', 200)
      cy.get('[data-view-name="participationView"]').should('be.visible')
    })
  })

  describe('Anonymous participant', function () {
    beforeEach(function () {
      cy.intercept('GET', '/api/v3/users*').as('getUsers')
      cy.anonymousParticipant({ convoId: this.convoId })
    })

    it('Cannot access /m/:id', function () {
      cy.visit(this.adminPath)

      cy.wait('@getUsers').its('response.statusCode').should('eq', 401)
      cy.get('[data-view-name="participationView"]').should('not.exist')
      cy.location('pathname').should('eq', '/signin')
    })

    it('Can access /:id', function () {
      cy.visit('/' + this.convoId)
      cy.wait('@participationInit').its('response.statusCode').should('eq', 200)
      cy.get('[data-view-name="participationView"]').should('be.visible')
    })
  })
})
