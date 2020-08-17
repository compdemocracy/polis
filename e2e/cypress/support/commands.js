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

Cypress.Commands.add("signup", (name, email, password) => {
  cy.visit('/createuser')

  cy.get('form').within(function () {
    cy.get('input#createUserNameInput').type(name)
    cy.get('input#createUserEmailInput').type(email)
    cy.get('input#createUserPasswordInput').type(password)
    cy.get('input#createUserPasswordRepeatInput').type(password)

    cy.get('button#createUserButton').click()
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
  }).then(resp => {
    console.log(resp)
  })
})
