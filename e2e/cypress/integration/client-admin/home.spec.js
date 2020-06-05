describe('Home Page', () => {
  beforeEach(() => cy.visit(''))

  it('bare Url redirects to /home', () => {
    cy.url().should('eq', Cypress.config().baseUrl + '/home')
  })

  it('has Demo and Sign in links', () => {
    cy.get('#root').find('a[href="/demo"]')
    cy.get('#root').find('a[href="/signin"]').should('have.length', 2)
  })
})
