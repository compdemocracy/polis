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
      const [userRole] = args ? args : ['participant']
      loginByRole(userRole)
      break
    default:
    case 2:
      const [email, password, ...rest] = args
      console.log(args)
      loginByPassword(email, password)
  }
})

Cypress.Commands.add("createConvo", (adminEmail, adminPassword) => {
  cy.login(adminEmail, adminPassword)
  cy.visit('/')

  cy.server()
  cy.route('GET', Cypress.config().apiPath + '/conversations**')
    .as('getNewConvo')

  cy.get('button').contains('Create new conversation').click()

  cy.wait('@getNewConvo').its('status').should('eq', 200)
  // Wait for header of convo admin page to be available.
  cy.contains('h3', 'Configure')
})
