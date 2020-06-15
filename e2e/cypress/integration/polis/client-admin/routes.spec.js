describe('Conversation Admin', () => {
  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]

      cy.createConvo(user.email, user.password)
    })
    cy.url('pathname').as('adminPath')
  })

  beforeEach(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.login(user.email, user.password)
    })
  })

  it('Page renders without trailing slash', function () {
    cy.visit(this.adminPath)
    cy.url().should('not.match', new RegExp('/$'))
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page renders with trailing slash', function () {
    cy.visit(this.adminPath + '/')
    cy.get('h3').should('have.text', 'Configure')
  })
})
