import { faker } from '@faker-js/faker'

/**
 * Authentication commands
 */

/**
 * Log in a user via UI or API
 * @param {Object} user - User object with email and password
 * @param {boolean} useUI - Whether to use UI (true) or API (false) for login
 */
Cypress.Commands.add('login', (user, useUI = false) => {
  if (useUI) {
    cy.intercept('POST', '/api/v3/auth/login').as('login')
    cy.visit('/signin')

    cy.get('form input#signinEmailInput').type(user.email)
    cy.get('form input#signinPasswordInput').type(user.password)
    cy.get('form button#signinButton').click()
    cy.wait('@login')
  } else {
    apiLogin(user)
  }
})

/**
 * Log out a user via UI or API
 * @param {boolean} useUI - Whether to use UI (true) or API (false) for logout
 */
Cypress.Commands.add('logout', (useUI = false) => {
  if (useUI) {
    cy.intercept('POST', '/api/v3/auth/deregister').as('logout')
    cy.visit('/')

    cy.contains('a[href="/signout"]', 'sign out').click()
    cy.wait('@logout')
  } else {
    cy.request('POST', '/api/v3/auth/deregister').then(() => cy.clearCookies())
  }
})

/**
 * Register a new user via UI or API
 * @param {Object} user - User object with name, email, and password
 * @param {boolean} useUI - Whether to use UI (true) or API (false) for registration
 */
Cypress.Commands.add('register', (user, useUI = false) => {
  if (useUI) {
    cy.intercept('POST', '/api/v3/auth/new').as('register')
    cy.visit('/createuser')

    cy.get('form input#createUserNameInput').type(user.name)
    cy.get('form input#createUserEmailInput').type(user.email)
    cy.get('form input#createUserPasswordInput').type(user.password)
    cy.get('form input#createUserPasswordRepeatInput').type(user.password)
    cy.get('form button#createUserButton').click()
    cy.wait('@register')

    // Conditionally check if the user already exists.
    // If the user already exists, log them in.
    cy.get('#root').then(($root) => {
      if ($root.text().includes('Email address already in use')) {
        cy.login(user, true)
      }
    })
  } else {
    cy.request({
      method: 'POST',
      url: '/api/v3/auth/new',
      body: {
        hname: user.name,
        email: user.email,
        password: user.password,
        gatekeeperTosPrivacy: 'true',
      },
      log: true,
      failOnStatusCode: false,
    }).then((response) => {
      console.log('Registration response status:', response.status)
      console.log('Registration response body:', response.body)

      if (response.status == 403) {
        console.log('User already exists, attempting login')
        apiLogin(user)
      } else if (response.status === 200) {
        console.log('Registration successful')
      } else {
        console.error('Registration failed with unexpected status:', response.status)
      }
    })
  }
})

/**
 * Ensure a user is logged in (creates session if needed)
 * @param {string} userLabel - User label from fixtures/users.json
 */
Cypress.Commands.add('ensureUser', (userLabel = 'participant') => {
  cy.session(
    userLabel,
    () => {
      cy.fixture('users').then((usersJson) => {
        const user = usersJson[userLabel]
        cy.register(user)
      })
    },
    {
      validate: () => {
        cy.getCookie('token2').should('exist')
        cy.getCookie('uid2').should('exist')
      },
    },
  )
})

/**
 * Conversation management commands
 */

/**
 * Create a conversation
 * @param {string} topic - Conversation topic
 * @param {string} description - Conversation description
 * @param {Object|string} user - User object or userLabel from fixtures/users.json
 */
Cypress.Commands.add('createConvo', (topic, description, user) => {
  // If user provided as string (userLabel), ensure that user is logged in
  if (typeof user === 'string') {
    cy.ensureUser(user)
  }
  // If user provided as object, login
  else if (user) {
    apiLogin(user)
  }

  cy.request('POST', '/api/v3/conversations', {
    is_active: true,
    is_draft: true,
    ...(topic && { topic }),
    ...(description && { description }),
  })
    .its('body.conversation_id')
    .as('convoId')
})

/**
 * Find or create a conversation for testing
 * @param {string} userLabel - User label from fixtures/users.json
 */
Cypress.Commands.add('ensureConversation', (userLabel) => {
  cy.ensureUser(userLabel)
  cy.request('/api/v3/conversations')
    .its('body')
    .then((convos = []) => {
      // find the first active conversation, if one exists
      const conversation = convos.find((convo) => convo.is_active)

      if (conversation) {
        cy.wrap(conversation.conversation_id).as('convoId')
      } else {
        cy.createConvo()
      }
    })
})

/**
 * Add a seed comment to a conversation
 * @param {string} convoId - Conversation ID
 * @param {string} commentText - Comment text (random if not provided)
 * @param {string} userLabel - User label from fixtures/users.json
 */
Cypress.Commands.add('seedComment', (convoId, commentText, userLabel) => {
  const text = commentText || faker.lorem.sentences()

  // If userLabel provided, ensure user is logged in
  if (userLabel) {
    cy.ensureUser(userLabel)
  }

  cy.request('POST', '/api/v3/comments', {
    conversation_id: convoId,
    is_seed: true,
    pid: 'mypid',
    txt: text,
  })
})

/**
 * Voting commands
 */

/**
 * Vote on a comment (internal use by voteOnConversation)
 */
Cypress.Commands.add('vote', () => {
  cy.intercept('POST', '/api/v3/votes').as('postVotes')

  // randomly select one of [agree, disagree, pass]
  const selectors = ['button#agreeButton', 'button#disagreeButton', 'button#passButton']
  const selector = selectors[Math.floor(Math.random() * 3)]

  cy.get('[data-view-name="vote-view"]').then(($voteView) => {
    if ($voteView.find('.Notification.Notification--warning').length) {
      // You've voted on all the statements.
      return
    }

    $voteView.find(selector).click()
    cy.wait('@postVotes')
  })
})

/**
 * Vote on all available comments in a conversation
 * @param {string} convoId - Conversation ID
 * @param {string} xid - External user ID (optional)
 */
Cypress.Commands.add('voteOnConversation', (convoId, xid) => {
  cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  let url = '/' + convoId

  if (xid) {
    url += '?xid=' + xid
  }

  cy.visit(url)
  cy.wait('@participationInit')

  cy.get('[data-view-name="vote-view"]', { timeout: 10000 }).then(function voteLoop($voteView) {
    if (
      $voteView.find('button#agreeButton').length &&
      !$voteView.find('.Notification.Notification--warning').length
    ) {
      cy.vote()
      cy.get('[data-view-name="vote-view"]').then(voteLoop)
    }
  })
})

/**
 * Open a conversation in a specific language
 * @param {string} convoId - Conversation ID
 * @param {string} lang - Language code
 */
Cypress.Commands.add('openTranslated', (convoId, lang) => {
  cy.visit('/' + convoId, { qs: { ui_lang: lang } })
})

/**
 * Embed commands
 */

/**
 * Get the body of an iframe
 */
Cypress.Commands.add('getIframeBody', () => {
  return cy.get('iframe').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)
})

/**
 * Intercept embed requests with embed/index.html
 */
Cypress.Commands.add('interceptEmbed', () => {
  cy.readFile('./embed/index.html').then((html) => {
    cy.intercept('GET', '/embedded', (req) => {
      req.reply({
        statusCode: 200,
        body: html,
        headers: {
          'Content-Type': 'text/html',
        },
      })
    })
  })
})

/**
 * Intercept integrated embed requests with embed/integrated-index.html
 */
Cypress.Commands.add('interceptIntegrated', () => {
  cy.readFile('./embed/integrated-index.html').then((html) => {
    cy.intercept('GET', '/integrated*', (req) => {
      req.reply({
        statusCode: 200,
        body: html,
        headers: {
          'Content-Type': 'text/html',
        },
      })
    })
  })
})

/**
 * Helper function for API login
 * @param {Object} user - User object with email and password
 */
function apiLogin(user) {
  cy.request({
    method: 'POST',
    url: '/api/v3/auth/login',
    body: {
      email: user.email,
      password: user.password,
    },
    log: true,
    failOnStatusCode: false,
  }).then((response) => {
    console.log('Login response status:', response.status)
    console.log('Login response body:', response.body)

    if (response.status === 200 && response.body.token) {
      cy.setCookie('token2', response.body.token)
      cy.setCookie('uid2', String(response.body.uid))

      // Verify cookies were set
      cy.getCookie('token2').then((cookie) => {
        console.log('token2 cookie after setting:', cookie)
      })
      cy.getCookie('uid2').then((cookie) => {
        console.log('uid2 cookie after setting:', cookie)
      })
    } else {
      console.error('Authentication failed:', response.status, response.body)
    }
  })
}
