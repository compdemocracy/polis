Cypress.Commands.add('login', (user) => {
  cy.intercept('POST', '/api/v3/auth/login').as('login')
  cy.visit('/signin')
  cy.contains('h1', 'Sign In').should('be.visible')
  cy.get('form input#signinEmailInput').type(user.email)
  cy.get('form input#signinPasswordInput').type(user.password)
  cy.get('form button#signinButton').click()
  cy.wait('@login')
})

Cypress.Commands.add('loginViaAPI', (user) => {
  apiLogin(user)
})

Cypress.Commands.add('logout', () => {
  cy.intercept('POST', '/api/v3/auth/deregister').as('logout')
  cy.visit('/')

  cy.contains('a[href="/signout"]', 'sign out').click()
  cy.wait('@logout')

  cy.getCookie('token2').should('not.exist')
  cy.getCookie('uid2').should('not.exist')
})

Cypress.Commands.add('logoutViaAPI', () => {
  cy.request({
    method: 'POST',
    url: '/api/v3/auth/deregister',
  }).then(() => cy.clearCookies())
})

Cypress.Commands.add('register', (user) => {
  cy.intercept('POST', '/api/v3/auth/new').as('register')
  cy.visit('/createuser')

  cy.contains('h1', 'Create Account').should('be.visible')

  cy.get('form input#createUserNameInput').type(user.name)
  cy.get('form input#createUserEmailInput').type(user.email)
  cy.get('form input#createUserPasswordInput').type(user.password)
  cy.get('form input#createUserPasswordRepeatInput').type(user.password)
  cy.get('form button#createUserButton').click()
  cy.wait('@register')

  // Conditionally check if the user already exist.
  // If the user already exists, log them in.
  cy.get('#root').then(($root) => {
    if ($root.text().includes('Email address already in use')) {
      cy.login(user)
    }
  })
})

Cypress.Commands.add('registerViaAPI', (user) => {
  cy.request({
    method: 'POST',
    url: '/api/v3/auth/new',
    body: {
      hname: user.name,
      email: user.email,
      password: user.password,
      gatekeeperTosPrivacy: 'true',
    },
    failOnStatusCode: false,
  }).then(({ body, status }) => {
    // Conditionally check if the user already exist.
    // If the user already exists, log them in.
    if (status == 403) {
      apiLogin(user)
    } else {
      cy.setCookie('token2', String(body.token))
      cy.setCookie('uid2', String(body.uid))
    }
  })
})

Cypress.Commands.add('createConvo', () => {})

Cypress.Commands.add('seedComment', () => {})

function apiLogin(user) {
  return cy
    .request({
      method: 'POST',
      url: '/api/v3/auth/login',
      body: { email: user.email, password: user.password },
    })
    .then(({ body }) => {
      cy.setCookie('token2', String(body.token))
      cy.setCookie('uid2', String(body.uid))
    })
}
