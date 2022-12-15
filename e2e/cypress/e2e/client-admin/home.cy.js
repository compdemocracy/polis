describe('Home Page', () => {
  beforeEach(() => cy.visit('/'))

  it('bare Url redirects to /home', () => {
    cy.location('pathname').should('eq', '/home')
  })

  it('has Sign up and Sign in links', () => {
    cy.get('#root').find('a[href="/createuser"]')
    cy.get('#root').find('a[href="/signin"]').should('have.length', 2)
  })
})
