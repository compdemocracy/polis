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
import { loginStandardUser, loginStandardUserAPI, logout, checkOidcSimulator } from './auth-helpers.js'

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

/**
 * Wait for OIDC system to be fully ready
 * Useful for CI environments where services may take time to initialize
 */
Cypress.Commands.add('waitForOidcReady', (options = {}) => {
  const { timeout = 30000, retries = 5 } = options
  const authIssuer = Cypress.env('AUTH_ISSUER')
  const baseIssuer = authIssuer && authIssuer.endsWith('/') ? authIssuer : `${authIssuer || ''}/`

  cy.log(`⏳ Waiting for OIDC system to be ready (timeout: ${timeout}ms)...`)

  const endpoints = [
    `${baseIssuer}.well-known/jwks.json`,
    `${baseIssuer}.well-known/openid-configuration`,
  ]

  let attempt = 0
  const perRequestTimeout = Math.max(1000, Math.floor(timeout / Math.max(1, retries)))

  const checkOnce = () => {
    attempt++
    cy.log(`🔄 OIDC readiness check attempt ${attempt}/${retries}`)

    let jwksStatus
    let openIdStatus

    return cy
      .request({
        url: endpoints[0],
        timeout: perRequestTimeout,
        retryOnNetworkFailure: true,
        failOnStatusCode: false,
      })
      .then((resp) => {
        jwksStatus = resp.status
      })
      .then(() =>
        cy.request({
          url: endpoints[1],
          timeout: perRequestTimeout,
          retryOnNetworkFailure: true,
          failOnStatusCode: false,
        })
      )
      .then((resp) => {
        openIdStatus = resp.status
      })
      .then(() => {
        const ok = jwksStatus === 200 && openIdStatus === 200
        if (ok) {
          cy.log('✅ OIDC system is ready')
          return
        }

        if (attempt < retries) {
          cy.log(`⚠️ OIDC not ready yet (jwks: ${jwksStatus}, openid: ${openIdStatus}), retrying in ${attempt * 1000}ms...`)
          return cy.wait(attempt * 1000).then(() => checkOnce())
        }

        throw new Error(
          `OIDC system failed to become ready after ${retries} attempts (jwks: ${jwksStatus}, openid: ${openIdStatus})`
        )
      })
  }

  return checkOnce()
})

/**
 * Setup OIDC readiness check for test suites
 * Use this in test files that require OIDC authentication
 * 
 * Usage in test files:
 *   describe('My Test', () => {
 *     before(() => cy.setupOidcReadiness())
 *     // ... your tests
 *   })
 */
Cypress.Commands.add('setupOidcReadiness', (options = {}) => {
  const { skipIfAlreadyChecked = true } = options
  
  // Store check status in Cypress environment
  if (skipIfAlreadyChecked && Cypress.env('oidcReadinessChecked')) {
    cy.log('⚡ OIDC readiness already verified in previous test')
    return
  }
  
  cy.log('🔐 Ensuring OIDC authentication system is ready...')
  
  // In CI, use the robust wait with retries
  if (Cypress.env('CI')) {
    cy.log('🔄 CI Environment detected - using robust OIDC readiness check')
    cy.waitForOidcReady({ 
      timeout: 30000,  // 30 seconds total timeout
      retries: 5       // Up to 5 retry attempts with progressive backoff
    })
    Cypress.env('oidcReadinessChecked', true)
  } else {
    // In local dev, use a quicker check
    cy.log('💻 Local environment - using quick OIDC check')
    
    // Use checkOidcSimulator from auth-helpers (already imported at top of file)
    checkOidcSimulator({ timeout: 10000 })
  }
  
  cy.log('✅ OIDC system confirmed ready')
})
