describe('Share page', () => {
  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.createConvo(user.email, user.password)
    })

    cy.get('#strict_moderation').check()
    cy.get('#auth_needed_to_write').uncheck()

    cy.location('pathname').then((adminPath) => {
      cy.wrap(adminPath).as('adminPath')
      cy.wrap(adminPath.replace('/m/', '/')).as('convoPath')
    })
  })

  beforeEach(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.login(user.email, user.password)
    })
  })

  it('has link with proper domain', function () {
    cy.visit(this.adminPath + '/share')

    cy.contains('#root', Cypress.config().baseUrl)
  })

  it('shows warnings when no comments', function () {

    cy.route('POST', Cypress.config().apiPath + '/comments').as('newComment')

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
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no comments').should('exist')

    cy.visit(this.convoPath)
    cy.get('#comment_form_textarea').type('moderated comment, to accept')
    cy.get('#comment_button').click()
    cy.wait('@newComment').its('status').should('eq', 200)
    cy.visit(this.adminPath + '/comments')
    cy.contains('button', 'accept').should('exist')
    cy.contains('button', 'accept').click()
    cy.visit(this.adminPath + '/share')
    cy.contains('#root', 'has no comments').should('not.exist')
    cy.contains('#root', 'has no visible comments').should('not.exist')
  })
})
