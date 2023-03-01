const user1 = 'mod01'
const user2 = 'mod02'

describe('User Auth', function () {
  beforeEach(function () {
    cy.fixture('users').as('usersJson')
  })

  it('should redirect unauthenticated user to signin page', function () {
    cy.visit('/account')
    cy.location('pathname').should('eq', '/signin')
  })

  it('should allow a visitor to register, log out, and log in, via UI', function () {
    const userInfo = this.usersJson[user1]
    cy.visit('/home')
    cy.contains('a[href="/createuser"]', 'Sign up').click()

    cy.location('pathname').should('eq', '/createuser')

    // Register User
    cy.register(userInfo)
    cy.visit('/')

    cy.location('pathname').should('eq', '/')
    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')

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

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')
  })

  // This is redundant with the above test, but it's a nice sanity check to use with `it.only`
  it('should allow a user to log in, via UI', function () {
    const userInfo = this.usersJson[user1]
    cy.login(userInfo)

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')
  })

  it('should allow a visitor to register, log out, and log in, via API', function () {
    const userInfo = this.usersJson[user2]

    cy.registerViaAPI(userInfo)
    cy.logoutViaAPI()
    cy.loginViaAPI(userInfo)

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')
  })
})
