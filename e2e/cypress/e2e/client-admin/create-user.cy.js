import { generateRandomUser } from '../../support/helpers'

describe('Create User page', function () {
  it('should redirect unauthenticated user to signin page', function () {
    cy.visit('/account')
    cy.location('pathname').should('eq', '/signin')
  })

  it('should allow a visitor to register, log out, and log in, via UI', function () {
    const user = generateRandomUser()
    cy.visit('/home')
    cy.contains('a[href="/createuser"]', 'Sign up').click()

    cy.location('pathname').should('eq', '/createuser')

    // Register User
    cy.registerViaUI(user)
    cy.visit('/')

    cy.location('pathname').should('eq', '/')
    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')

    // Log out User
    cy.logoutViaUI()

    cy.visit('/')
    cy.location('pathname').should('eq', '/home')
    cy.contains('a[href="/signin"]', 'Sign in').first().click()
    cy.location('pathname').should('eq', '/signin')
    cy.contains('h1', 'Sign In').should('be.visible')

    // Log in User
    cy.login(user)

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')
  })

  it('should allow a visitor to register, log out, and log in, via API', function () {
    const user = generateRandomUser()

    cy.register(user)
    cy.logout()
    cy.loginViaAPI(user)

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')

    cy.visit('/')
    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')
  })

  it('should give an error if a user tries to register with an existing email', function () {
    const user = generateRandomUser()

    cy.register(user)
    cy.logout()

    cy.intercept('POST', '/api/v3/auth/new').as('register')
    cy.visit('/createuser')

    cy.get('form input#createUserNameInput').type(user.name)
    cy.get('form input#createUserEmailInput').type(user.email)
    cy.get('form input#createUserPasswordInput').type(user.password)
    cy.get('form input#createUserPasswordRepeatInput').type(user.password)
    cy.get('form button#createUserButton').click()

    cy.wait('@register').its('response.statusCode').should('eq', 403)
    cy.contains('h1', 'Create Account').should('be.visible')
    cy.contains('Email address already in use').should('be.visible')
  })
})
