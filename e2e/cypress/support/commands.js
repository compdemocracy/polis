Cypress.Commands.add('login', (user) => {
  cy.session(
    ['login', user.email],
    () => {
      cy.intercept('POST', '/api/v3/auth/login').as('login')
      cy.visit('/signin')

      cy.contains('h1', 'Sign In').should('be.visible')

      cy.get('form input#signinEmailInput').type(user.email)
      cy.get('form input#signinPasswordInput').type(user.password)
      cy.get('form button#signinButton').click()
      cy.wait('@login')
    },
    {
      validate: () => {
        cy.getCookie('token2').should('exist')
        cy.getCookie('uid2').should('exist')
      },
    }
  )
})

Cypress.Commands.add('loginViaAPI', (user) => {
  cy.session(
    ['login', user.email],
    () => {
      cy.request({
        method: 'POST',
        url: '/api/v3/auth/login',
        body: { email: user.email, password: user.password },
        // headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      })
    },
    {
      validate: () => {
        cy.getCookie('token2').should('exist')
        cy.getCookie('uid2').should('exist')
      },
    }
  )
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
    // headers: { 'Content-Type': 'application/json', Accept: '*/*' },
  }).then(() => cy.clearCookies())
})

Cypress.Commands.add('register', (user) => {
  cy.session(
    ['register', user.email],
    () => {
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
    },
    {
      validate: () => {
        cy.getCookie('token2').should('exist')
        cy.getCookie('uid2').should('exist')
      },
    }
  )
})

Cypress.Commands.add('registerViaAPI', (user) => {
  cy.session(
    ['register', user.email],
    () => {
      cy.request({
        method: 'POST',
        url: '/api/v3/auth/new',
        body: {
          hname: user.name,
          email: user.email,
          password: user.password,
          gatekeeperTosPrivacy: 'true',
        },
        // headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        failOnStatusCode: false,
      }).then((response) => {
        if (response.status == 403) {
          cy.loginViaAPI(user)
        }
      })
    },
    {
      validate: () => {
        cy.getCookie('token2').should('exist')
        cy.getCookie('uid2').should('exist')
      },
    }
  )
})

Cypress.Commands.add('createConvo', () => {})

Cypress.Commands.add('seedComment', () => {})
