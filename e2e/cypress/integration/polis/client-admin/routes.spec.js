describe('Routes', () => {
  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.createConvo(user.email, user.password)
    })
    cy.location('pathname').as('adminPath')
  })

  beforeEach(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.login(user.email, user.password)
    })
  })

  it('Page renders without trailing slash for /m/:id', function () {
    cy.visit(this.adminPath)

    cy.location('pathname').should('not.match', new RegExp('/$'))
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page strips trailing slash from /m/:id/', function () {
    cy.visit(this.adminPath + '/')

    cy.location('pathname').should('eq', this.adminPath)
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page strips trailing slash from /m/:id/share/', function () {
    const sharePath = this.adminPath + '/share'
    cy.visit(sharePath + '/')

    cy.location('pathname').should('eq', sharePath)
    cy.get('h3').should('have.text', 'Distribute')
  })

  it('Page strips trailing slash from /m/:id/comments/accepted/', function () {
    const moderatePath = this.adminPath + '/comments/accepted'
    cy.visit(moderatePath + '/')

    cy.location('pathname').should('eq', moderatePath)
    cy.get('h3').should('have.text', 'Moderate')
  })

  it('Page strips trailing slash from /account/', function () {
    const accountPath = '/account'
    cy.visit(accountPath + '/')

    cy.location('pathname').should('eq', accountPath)
    cy.get('h3').should('have.text', 'Account')
  })
})
