describe('Share page', () => {
  before(function () {
    cy.createConvo('moderator').then(() => {
      cy.wrap(`/m/${this.convoId}`).as('adminPath')
      cy.wrap(`/${this.convoId}`).as('convoPath')
    })

    cy.get('input[data-test-id="strict_moderation"]').check()
    cy.get('input[data-test-id="auth_needed_to_write"]').uncheck()
  })

  beforeEach(() => {
    cy.server()
    cy.login('moderator')
  })

  it('has link with proper domain', function () {
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', Cypress.config().baseUrl)
  })

  it('shows warnings when no comments', function () {
    cy.route('POST', Cypress.config().apiPath + '/comments').as('newComment')
    cy.route('PUT', Cypress.config().apiPath + '/comments').as('updateComment')

    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no comments').should('exist')

    cy.visit(this.convoPath)
    cy.get('#comment_form_textarea').type('moderated comment, to reject')
    cy.get('#comment_button').click()
    cy.wait('@newComment').its('status').should('eq', 200)
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no visible comments').should('exist')

    cy.visit(this.adminPath + '/comments')
    cy.contains('button', 'reject').should('exist')
    cy.contains('button', 'reject').click()
    cy.wait('@updateComment').its('status').should('eq', 200)
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no comments').should('exist')

    cy.visit(this.convoPath)
    cy.get('#comment_form_textarea').type('moderated comment, to accept')
    cy.get('#comment_button').click()
    cy.wait('@newComment').its('status').should('eq', 200)
    cy.visit(this.adminPath + '/comments')
    cy.contains('button', 'accept').should('exist')
    cy.contains('button', 'accept').click()
    cy.wait('@updateComment').its('status').should('eq', 200)
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no comments').should('not.exist')
    cy.contains('#root', 'has no visible comments').should('not.exist')
  })
})
