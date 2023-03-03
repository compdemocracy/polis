Cypress.Commands.add('login', (user) => {
  cy.intercept('POST', '/api/v3/auth/login').as('login')
  cy.visit('/signin')
  cy.contains('h1', 'Sign In').should('be.visible')
  cy.get('form input#signinEmailInput').type(user.email)
  cy.get('form input#signinPasswordInput').type(user.password)
  cy.get('form button#signinButton').click()
  cy.wait('@login')
})

Cypress.Commands.add('loginViaAPI', (user) => apiLogin(user))

Cypress.Commands.add('logout', () => {
  cy.intercept('POST', '/api/v3/auth/deregister').as('logout')
  cy.visit('/')

  cy.contains('a[href="/signout"]', 'sign out').click()
  cy.wait('@logout')

  cy.getCookie('token2').should('not.exist')
  cy.getCookie('uid2').should('not.exist')
})

Cypress.Commands.add('logoutViaAPI', () => {
  cy.request('POST', '/api/v3/auth/deregister').then(() => cy.clearCookies())
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
  }).then(({ status }) => {
    // Conditionally check if the user already exist.
    // If the user already exists, log them in.
    if (status == 403) {
      apiLogin(user)
    }
  })
})

Cypress.Commands.add('ensureModerator', (userLabel = 'mod01') => {
  cy.session(
    'moderator',
    () => {
      cy.fixture('users').then((usersJson) => {
        const user = usersJson[userLabel]
        cy.registerViaAPI(user)
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

Cypress.Commands.add('ensureParticipant', (userLabel = 'user01') => {
  cy.session(
    'participant',
    () => {
      cy.fixture('users').then((usersJson) => {
        const user = usersJson[userLabel]
        cy.registerViaAPI(user)
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

Cypress.Commands.add('anonymousParticipant', ({ convoId }) => {
  if (!convoId) {
    throw new Error('convoId is not defined')
  }

  cy.session(
    'anonymous',
    () => {
      cy.request(
        '/api/v3/participationInit?conversation_id=' +
        convoId +
        '&pid=mypid&lang=acceptLang'
      )
    },
    {
      validate: () => {
        cy.getCookie('token2').should('be.null')
        cy.getCookie('uid2').should('be.null')
        cy.getCookie('pc').should('exist')
      },
    }
  )
})

Cypress.Commands.add('createConvoViaAPI', () => {
  cy.ensureModerator()
  cy.request('POST', '/api/v3/conversations', {
    is_active: true,
    is_draft: true,
  })
    .its('body.conversation_id')
    .as('convoId')
})

// Cypress.Commands.add('seedComment', () => {})

function apiLogin(user) {
  cy.request('POST', '/api/v3/auth/login', { email: user.email, password: user.password })
}
