// ***********************************************
// This example commands.js shows you how to
// create various custom commands and overwrite
// existing commands.
//
// For more comprehensive examples of custom
// commands please read more here:
// https://on.cypress.io/custom-commands
// ***********************************************
//
//
// -- This is a parent command --
// Cypress.Commands.add("login", (email, password) => { ... })
//
//
// -- This is a child command --
// Cypress.Commands.add("drag", { prevSubject: 'element'}, (subject, options) => { ... })
//
//
// -- This is a dual command --
// Cypress.Commands.add("dismiss", { prevSubject: 'optional'}, (subject, options) => { ... })
//
//
// -- This will overwrite an existing command --
// Cypress.Commands.overwrite("visit", (originalFn, url, options) => { ... })

Cypress.Commands.add("logout", () => {
  cy.request('POST', Cypress.config().apiPath + '/auth/deregister')
    .then(resp => {
      window.localStorage.removeItem('token2')
      window.localStorage.removeItem('uid2')
      window.localStorage.removeItem('uc')
      window.localStorage.removeItem('e')
    })
})

Cypress.Commands.add("signup", (name, email, password, strictFail=false) => {
  cy.request({
    method: 'POST',
    url: Cypress.config().apiPath + '/auth/new',
    body: {
      email: email,
      hname: name,
      gatekeeperTosPrivacy: true,
      password: password
    },
    failOnStatusCode: strictFail
  }).then(resp => {
    // Expand success criteria to allow user already existing.
    // TODO: Be smarter with seeding users so we only create once.
    if (!(resp.status === 200 || (resp.status === 403 && resp.body === 'polis_err_reg_user_with_that_email_exists'))) {
      throw new Error(`Unexpected error code ${resp.status} returned during signup: ${resp.body}`)
    }
  })
})

function loginByPassword (email, password) {
  cy.request('POST', Cypress.config().apiPath + '/auth/login', {
    email: email,
    password: password
  }).then(resp => {
    window.localStorage.setItem('token2', resp.body.token)
    window.localStorage.setItem('uid2', resp.body.uid)
    window.localStorage.setItem('uc', Date.now())
    window.localStorage.setItem('e', 1)
  })
}

function loginByRole (userRole) {
  cy.fixture('users.json').then((users) => {
    const user = users[userRole]
    loginByPassword(user.email, user.password)
  })
}

Cypress.Commands.add("login", (...args) => {
  cy.logout()

  switch (args.length) {
    case 0:
    case 1:
      const [userRole] = args.length ? args : ['moderator']
      loginByRole(userRole)
      break
    default:
    case 2:
      const [email, password, ...rest] = args
      loginByPassword(email, password)
  }
})

Cypress.Commands.add("createConvo", (...args) => {
  cy.login(...args)
  cy.request('POST', Cypress.config().apiPath + '/conversations', {
    is_active: true,
    is_draft: true
  }).its('body.conversation_id').as('convoId').then(x => {
    // TODO: Remove this once other tests no longer rely on assumption of pageload.
    cy.visit('/m/'+x)
  })
})

Cypress.Commands.add('seedComment', (...args) => {
  const [commentText, convoId, ...rest] = args
  cy.login(...rest)
  cy.request('POST', Cypress.config().apiPath + '/comments', {
    txt: commentText,
    pid: 'mypid',
    conversation_id: convoId,
    is_seed: true
  })
})

// Allow visiting maildev inbox urls, to test sending of emails.
// See: https://github.com/cypress-io/cypress/issues/944#issuecomment-651503805
Cypress.Commands.overwrite(
  'visit',
  (originalFn, url, options) => {
    if (url.includes(':1080')) {
      cy.window().then(win => {
        return win.open(url, '_self');
      });
    }
    else { return originalFn(url, options); }
  }
);
