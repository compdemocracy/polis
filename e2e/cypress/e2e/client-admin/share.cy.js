describe('Share page', function () {
  before(function () {
    cy.createConvo()
      .then(() => {
        cy.wrap(`/m/${this.convoId}`).as('adminPath')
        cy.wrap(`/${this.convoId}`).as('convoPath')
      })
      .then(() => cy.visit(this.adminPath))

    cy.get('input[data-test-id="strict_moderation"]').check()
  })

  beforeEach(function () {
    cy.ensureUser('moderator')
    cy.intercept('POST', '/api/v3/comments').as('createComment')
    cy.intercept('PUT', '/api/v3/comments').as('updateComment')
  })

  it('has link with proper domain', function () {
    cy.visit(this.adminPath + '/share')
    cy.contains(Cypress.config('baseUrl'))
  })

  it('shows warnings when no comments', function () {
    cy.visit(this.adminPath + '/share')
    cy.contains('has no comments').should('be.visible')

    cy.visit(this.convoPath)
    cy.get('#comment_form_textarea').type('moderated comment, to reject')
    cy.get('#comment_button').click()

    cy.wait('@createComment').its('response.statusCode').should('eq', 200)

    cy.visit(this.adminPath + '/share')
    cy.contains('has no visible comments').should('be.visible')

    cy.visit(this.adminPath + '/comments')
    cy.contains('button', 'reject').should('be.visible')
    cy.contains('button', 'reject').click()

    cy.wait('@updateComment').its('response.statusCode').should('eq', 200)
    cy.visit(this.adminPath + '/share')
    cy.contains('has no comments').should('be.visible')

    cy.visit(this.convoPath)
    cy.get('#comment_form_textarea').type('moderated comment, to accept')
    cy.get('#comment_button').click()

    cy.wait('@createComment').its('response.statusCode').should('eq', 200)

    cy.visit(this.adminPath + '/comments')
    cy.contains('button', 'accept').should('be.visible')
    cy.contains('button', 'accept').click()

    cy.wait('@updateComment').its('response.statusCode').should('eq', 200)

    cy.visit(this.adminPath + '/share')
    cy.contains('has no comments').should('not.exist')
    cy.contains('has no visible comments').should('not.exist')
  })
})
