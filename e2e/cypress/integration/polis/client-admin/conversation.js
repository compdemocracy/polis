describe('Conversation Admin', () => {
  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.createConvo(user.email, user.password)
      cy.url('pathname').as('adminPath')
    })
  })

  it('Page renders without trailing slash', function () {
    cy.visit(this.adminPath)
    cy.url().should('not.match', new RegExp('/$'))
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page render properly without trailing slash', function () {
    cy.visit(this.adminPath + '/')
    cy.get('h3').should('have.text', 'Configure')
  })
})
