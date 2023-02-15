describe('Home Page', function() {
  beforeEach(function() { return cy.visit('/'); })

  it('bare URL redirects to /home', function() {
    cy.location('pathname').should('eq', '/home')
  })

  it('has Sign up and Sign in links', function() {
    cy.contains('a[href="/createuser"]', 'Sign up').should('be.visible')
    cy.contains('a[href="/signin"]', 'Sign in').should('be.visible')
  })
})
