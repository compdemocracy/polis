/**
 * Embed Testing Commands
 */

/**
 * Get the body of an iframe - more robust than direct access
 * @param {string} selector - Optional iframe selector (defaults to first iframe)
 */
Cypress.Commands.add('getIframeBody', (selector = 'iframe') => {
  return cy.get(selector).its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)
})

/**
 * Intercept embed requests with generated embed/index.html
 * Automatically reads the file and sets up the intercept
 */
Cypress.Commands.add('interceptEmbed', () => {
  cy.readFile('./embed/index.html').then((html) => {
    cy.intercept('GET', '/embedded', {
      statusCode: 200,
      body: html,
      headers: {
        'Content-Type': 'text/html',
      },
    }).as('embedPage')
  })
})

/**
 * Intercept integrated embed requests with generated embed/integrated-index.html
 * Automatically reads the file and sets up the intercept
 */
Cypress.Commands.add('interceptIntegrated', () => {
  cy.readFile('./embed/integrated-index.html').then((html) => {
    cy.intercept('GET', '/integrated', {
      statusCode: 200,
      body: html,
      headers: {
        'Content-Type': 'text/html',
      },
    }).as('integratedPage')
  })
})

/**
 * Report Testing Commands
 */

// Import the helper functions
import { createTestConversation, addCommentToConversation } from './conversation-helpers.js'
import { navigateToConversationSection } from './admin-helpers.js'
import { loginStandardUser, loginStandardUserAPI, logout } from './auth-helpers.js'

// Register conversation creation command
Cypress.Commands.add('createConversation', (options = {}) => {
  return createTestConversation(options)
})

// Register comment addition command
Cypress.Commands.add('addComment', (conversationId, text, userEmail, userPassword) => {
  return addCommentToConversation(conversationId, text, userEmail, userPassword)
})

// Register navigation command
Cypress.Commands.add('navigateToConversationSection', (conversationId, section) => {
  return navigateToConversationSection(conversationId, section)
})

// Register logout command
Cypress.Commands.add('logout', () => {
  return logout()
})

// Register standard user login command (if not already registered)
Cypress.Commands.add('loginStandardUser', (email, password) => {
  return loginStandardUser(email, password)
})

// Register standard user API login command (if not already registered)
Cypress.Commands.add('loginStandardUserAPI', (email, password) => {
  return loginStandardUserAPI(email, password)
})
