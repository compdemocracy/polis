import {
  loginStandardUser,
  logout,
  checkOidcSimulator,
  verifyJWTClaims,
  verifyCustomNamespaceClaims,
  verifyIDTokenClaims,
  verifyServerJWTValidation,
} from '../../support/auth-helpers.js'

describe('OIDC Standard User Authentication', () => {
  before(() => {
    // One-time setup: ensure OIDC simulator is ready
    cy.log('🔧 Initial setup: ensuring OIDC system is fully ready...')
    
    // Use the more robust waitForOidcReady for initial setup
    // This is especially important in CI where this may be the first test
    if (Cypress.env('CI')) {
      cy.waitForOidcReady({ timeout: 30000, retries: 5 })
    } else {
      // Lighter check for local development
      const localTimeout = 10000
      checkOidcSimulator({ timeout: localTimeout })
    }
  })
  
  beforeEach(() => {
    const ciTimeout = Cypress.env('CI') ? 20000 : 10000
    
    // Clear all state comprehensively
    cy.log('🧹 Clearing all authentication state...')
    cy.clearAllCookies()
    cy.clearAllLocalStorage()
    cy.clearAllSessionStorage()
    
    // Visit home page to ensure clean app state
    cy.visit('/', { timeout: ciTimeout })
    
    // Wait for page to be fully interactive
    cy.document().should('exist')
    cy.window({ timeout: ciTimeout }).should('have.property', 'atob')
    cy.window().should('have.property', 'location')
    
    // Additional wait for CI stability (allows JS to fully initialize)
    if (Cypress.env('CI')) {
      cy.wait(1000)
    }
    
    // Ensure completely logged out
    logout()
    
    // Verify OIDC simulator is still accessible
    checkOidcSimulator({ timeout: ciTimeout })
  })
  
  afterEach(() => {
    // Clean up after each test to prevent state pollution
    cy.log('🧹 Test cleanup...')
    logout()
  })

  it('should authenticate admin user via OIDC simulator', () => {
    const email = 'admin@polis.test'
    const password = 'Te$tP@ssw0rd*'
    const timeout = Cypress.env('CI') ? 15000 : 10000

    loginStandardUser(email, password, { timeout })

    // Verify the access token contains expected custom namespace claims
    verifyCustomNamespaceClaims('oidc', {
      email: email,
      name: 'Test Admin',
      email_verified: true,
    }, { timeout })

    // Verify the access token contains standard claims
    verifyJWTClaims('oidc', {
      aud: Cypress.env('AUTH_AUDIENCE'),
    })

    // Verify the ID token contains standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Admin',
      email_verified: true,
    }, { timeout })

    // Verify server accepts the JWT
    verifyServerJWTValidation()
  })

  it('should authenticate moderator user via OIDC simulator', () => {
    const email = 'moderator@polis.test'
    const password = 'Te$tP@ssw0rd*'
    const timeout = Cypress.env('CI') ? 15000 : 10000

    loginStandardUser(email, password, { timeout })

    // Verify the access token contains expected custom namespace claims
    verifyCustomNamespaceClaims('oidc', {
      email: email,
      name: 'Test Moderator',
      email_verified: true,
    }, { timeout })

    // Verify the access token contains standard claims
    verifyJWTClaims('oidc', {
      aud: Cypress.env('AUTH_AUDIENCE'),
    })

    // Verify the ID token contains standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Moderator',
      email_verified: true,
    }, { timeout })
    
    // Verify server accepts the JWT
    verifyServerJWTValidation()
  })

  it('should fail authentication with invalid credentials', () => {
    const authUrl = Cypress.env('AUTH_ISSUER')

    cy.visit(`${authUrl}authorize`, {
      qs: {
        response_type: 'code',
        client_id: Cypress.env('AUTH_CLIENT_ID'),
        redirect_uri: `${Cypress.config('baseUrl')}/auth/callback`,
        scope: 'openid profile email',
        audience: Cypress.env('AUTH_AUDIENCE'),
      },
    })

    // Try invalid credentials
    cy.get('#username').type('invalid@polis.test')
    cy.get('#password').type('wrongpassword')
    cy.get('button[type="submit"]').click()

    // Should show error or stay on login page
    cy.url().should('not.include', '/auth/callback')
  })

  it('should verify custom claims in JWT token', () => {
    const email = 'admin@polis.test'
    const password = 'Te$tP@ssw0rd*'
    const timeout = Cypress.env('CI') ? 15000 : 10000

    loginStandardUser(email, password, { timeout })

    // Verify access token has expected custom namespace claims
    verifyCustomNamespaceClaims('oidc', {
      email: email,
      name: 'Test Admin',
      email_verified: true,
    }, { timeout })

    // Verify ID token has expected standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Admin',
      email_verified: true,
    }, { timeout })
  })
})
