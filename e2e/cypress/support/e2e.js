// ***********************************************************
// This file is processed and loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import './commands.js'
import './auth-helpers.js'

// Alternatively you can use CommonJS syntax:
// require('./commands')

// Configure Cypress for Auth testing
Cypress.on('uncaught:exception', () => {
  // Prevent Cypress from failing on uncaught exceptions
  // This is useful for auth flows that might redirect
  return false
})

// Global before hook for all tests
// eslint-disable-next-line mocha/no-top-level-hooks
beforeEach(() => {
  // Set up any global state or configuration
  cy.log('🔄 Setting up test environment')

  // Only check server status if we're not testing embeds
  // Embed tests use intercepts and don't need real server checks
  const currentTest = Cypress.currentTest.title
  if (!currentTest.includes('embed') && !currentTest.includes('Embed')) {
    // Wait for services to be ready
    cy.request({
      url: '/api/v3/participationInit',
      failOnStatusCode: false,
    }).then((response) => {
      // Just checking that server is responding
      expect(response.status).to.be.oneOf([200, 403, 401])
    })
  }
})
