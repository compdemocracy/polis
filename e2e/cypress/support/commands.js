import { faker } from '@faker-js/faker'

Cypress.Commands.add('login', (user) => {
  cy.intercept('POST', '/api/v3/auth/login').as('login')
  cy.visit('/signin')

  cy.get('form input#signinEmailInput').type(user.email)
  cy.get('form input#signinPasswordInput').type(user.password)
  cy.get('form button#signinButton').click()
  cy.wait('@login')
})

Cypress.Commands.add('loginViaAPI', (user) => apiLogin(user))

Cypress.Commands.add('logoutViaUI', () => {
  cy.intercept('POST', '/api/v3/auth/deregister').as('logout')
  cy.visit('/')

  cy.contains('a[href="/signout"]', 'sign out').click()
  cy.wait('@logout')
})

Cypress.Commands.add('logout', () => {
  cy.request('POST', '/api/v3/auth/deregister').then(() => cy.clearCookies())
})

Cypress.Commands.add('registerViaUI', (user) => {
  cy.intercept('POST', '/api/v3/auth/new').as('register')
  cy.visit('/createuser')

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

Cypress.Commands.add('register', (user) => {
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
    // Conditionally check if the user already exists.
    // If the user already exists, log them in.
    if (status == 403) {
      apiLogin(user)
    }
  })
})

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
        '/api/v3/participationInit?conversation_id=' + convoId + '&pid=mypid&lang=acceptLang'
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

Cypress.Commands.add('createConvo', (topic, description) => {
  cy.ensureUser('moderator')
  cy.request('POST', '/api/v3/conversations', {
    is_active: true,
    is_draft: true,
    ...(topic && { topic }),
    ...(description && { description }),
  })
    .its('body.conversation_id')
    .as('convoId')
})

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

Cypress.Commands.add('seedComment', (convoId, commentText) => {
  const text = commentText || faker.lorem.sentences()

  cy.ensureUser('moderator')
  cy.request('POST', '/api/v3/comments', {
    conversation_id: convoId,
    is_seed: true,
    pid: 'mypid',
    txt: text,
  })
})

Cypress.Commands.add('openTranslated', (convoId, lang) => {
  cy.visit('/' + convoId, { qs: { ui_lang: lang } })
})

// https://www.cypress.io/blog/2020/02/12/working-with-iframes-in-cypress/
Cypress.Commands.add('getIframeBody', () => {
  // get the iframe > document > body
  // and retry until the body element is not empty
  return (
    cy
      .get('iframe')
      .its('0.contentDocument.body')
      .should('not.be.empty')
      // wraps "body" DOM element to allow
      // chaining more Cypress commands, like ".find(...)"
      .then(cy.wrap)
  )
})

// Serve up the embed/index.html in response to a request to /embedded
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

Cypress.Commands.add('vote', () => {
  cy.intercept('POST', '/api/v3/votes').as('postVotes')

  // randomly select one of [agree, disagree, pass]
  // as a selector for the vote button
  const selector = ['button#agreeButton', 'button#disagreeButton', 'button#passButton'][
    Math.floor(Math.random() * 3)
  ]

  cy.get('[data-view-name="vote-view"]').find(selector).click()
  cy.wait('@postVotes')
})

Cypress.Commands.add('initAndVote', (userLabel, convoId) => {
  cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')

  cy.ensureUser(userLabel)
  cy.visit('/' + convoId)
  cy.wait('@participationInit')

  recursiveVote()
})

function apiLogin(user) {
  cy.request('POST', '/api/v3/auth/login', { email: user.email, password: user.password })
}

function recursiveVote() {
  cy.get('[data-view-name="vote-view"]').then(($voteView) => {
    if ($voteView.find('.Notification.Notification--warning').length) {
      // You've voted on all the statements.
      return
    } else {
      if ($voteView.find('button#agreeButton').length) {
        cy.vote().then(() => recursiveVote())
      }
    }
  })
}
