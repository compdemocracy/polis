describe('User Auth', function () {
  beforeEach(function () {
    cy.fixture('users').as('usersJson')
  })

  it('should redirect unauthenticated user to signin page', function () {
    cy.visit('/account')
    cy.location('pathname').should('eq', '/signin')
  })

  it('should allow a visitor to register, log out, and log in, via UI', function () {
    const userInfo = this.usersJson['mod01']
    cy.visit('/home')
    cy.contains('a[href="/createuser"]', 'Sign up').click()
    cy.location('pathname').should('eq', '/createuser')

    // Register User
    cy.register(userInfo)

    // Log out User
    cy.logout()

    cy.visit('/')
    cy.location('pathname').should('eq', '/home')
    cy.contains('a[href="/signin"]', 'Sign in').first().click()
    cy.location('pathname').should('eq', '/signin')
    cy.contains('h1', 'Sign In').should('be.visible')

    // Log in User
    cy.login(userInfo)

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')
  })

  it('should allow a visitor to register, log out, and log in, via API', function () {
    const userInfo = this.usersJson['mod02']

    cy.registerViaAPI(userInfo)
    cy.logoutViaAPI()
    cy.loginViaAPI(userInfo)

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')
  })
})
