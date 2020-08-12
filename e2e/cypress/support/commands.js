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
  cy.server()
  cy.route('POST', Cypress.config().apiPath + '/auth/deregister')
    .as('authLogout')

  cy.visit('/signout')

  cy.wait('@authLogout').its('status').should('eq', 200)
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

Cypress.Commands.add("login", (email, password) => {
  cy.logout()
  cy.visit('/signin')

  cy.server()
  cy.route({
    method: 'POST',
    url: Cypress.config().apiPath + '/auth/login'
  }).as('authLogin')

  cy.get('form').within(function () {
    cy.get('input#signinEmailInput').type(email)
    cy.get('input#signinPasswordInput').type(password)

    cy.get('button#signinButton').click()
  })

  cy.wait('@authLogin').its('status').should('eq', 200)
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
