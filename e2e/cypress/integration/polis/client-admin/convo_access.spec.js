describe('Access control', () => {
  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users.moderator
      cy.createConvo(user.email, user.password)
    })
    cy.location('pathname').as('adminPath')
  })

  beforeEach(() => {
    cy.fixture('users.json').then((users) => {
      const user = users.participant
      cy.login(user.email, user.password)
    })
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
})
