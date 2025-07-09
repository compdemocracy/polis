import {
  loginStandardUser,
  logout,
  checkAuth0Simulator,
  verifyJWTClaims,
  verifyCustomNamespaceClaims,
  verifyIDTokenClaims,
  verifyServerJWTValidation,
} from '../../support/auth-helpers.js'

describe('Auth0 Standard User Authentication', () => {
  beforeEach(() => {
    // Clear any existing auth state
    logout()

    // Check that Auth0 simulator is accessible
    checkAuth0Simulator()
  })

  it('should authenticate admin user via Auth0 simulator', () => {
    const email = 'admin@polis.test'
    const password = 'Te$tP@ssw0rd*'

    loginStandardUser(email, password)

    // Verify the access token contains expected custom namespace claims
    verifyCustomNamespaceClaims('auth0', {
      email: email,
      name: 'Test Admin',
      email_verified: true,
    })

    // Verify the access token contains standard claims
    verifyJWTClaims('auth0', {
      aud: Cypress.env('AUTH_AUDIENCE'),
    })

    // Verify the ID token contains standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Admin',
      email_verified: true,
    })

    // Verify server accepts the JWT
    verifyServerJWTValidation()
  })

  it('should authenticate moderator user via Auth0 simulator', () => {
    const email = 'moderator@polis.test'
    const password = 'Te$tP@ssw0rd*'

    loginStandardUser(email, password)

    // Verify the access token contains expected custom namespace claims
    verifyCustomNamespaceClaims('auth0', {
      email: email,
      name: 'Test Moderator',
      email_verified: true,
    })

    // Verify the access token contains standard claims
    verifyJWTClaims('auth0', {
      aud: Cypress.env('AUTH_AUDIENCE'),
    })

    // Verify the ID token contains standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Moderator',
      email_verified: true,
    })
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

    loginStandardUser(email, password)

    // Verify access token has expected custom namespace claims
    verifyCustomNamespaceClaims('auth0', {
      email: email,
      name: 'Test Admin',
      email_verified: true,
    })

    // Verify ID token has expected standard claims
    verifyIDTokenClaims({
      email: email,
      name: 'Test Admin',
      email_verified: true,
    })
  })
})
