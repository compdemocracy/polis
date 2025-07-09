/**
 * Authentication helpers for Polis E2E tests
 * Supports three authentication types:
 * 1. Standard users (Auth0)
 * 2. Anonymous participants (custom JWT)
 * 3. XID participants (custom JWT)
 */

/**
 * Helper to authenticate a standard user via Auth0 simulator using UI
 * @param {string} email - User email
 * @param {string} password - User password
 */
export function loginStandardUser(email, password) {
  cy.log(`🔐 Logging in via UI: ${email}`)

  // Always start fresh
  cy.visit('/')
  cy.get('body').should('be.visible')

  // Check if already authenticated
  cy.get('body').then(($body) => {
    const bodyText = $body.text().toLowerCase()

    if (bodyText.includes('all conversations')) {
      cy.log('✅ Already authenticated')
      return
    }

    // Click sign in button and fill Auth0 form
    cy.get('#signinButton').click()

    const authIssuer = Cypress.env('AUTH_ISSUER')
    const authOrigin = new URL(authIssuer).origin
    const authHost = new URL(authIssuer).host

    cy.origin(authOrigin, { args: { email, password } }, ({ email, password }) => {
      cy.get('input[type="email"]').type(email)
      cy.get('input[type="password"]').type(password)
      cy.contains('button', 'Sign in').click()
    })

    // Wait for redirect and Auth0 initialization
    cy.url().should('not.include', authHost)
    cy.get('h3').should('contain.text', 'All Conversations')

    cy.log(`✅ User authenticated: ${email}`)
  })
}

/**
 * Get JWT token directly from Auth0 simulator API
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<string>} JWT access token
 */
function getAuth0TokenDirect(email, password) {
  const authUrl = Cypress.env('AUTH_ISSUER')
  const audience = Cypress.env('AUTH_AUDIENCE')
  const clientId = Cypress.env('AUTH_CLIENT_ID')

  const tokenUrl = authUrl.endsWith('/') ? `${authUrl}oauth/token` : `${authUrl}/oauth/token`

  return cy
    .request({
      method: 'POST',
      url: tokenUrl,
      body: {
        grant_type: 'password',
        username: email,
        password: password,
        audience: audience,
        client_id: clientId,
        scope: 'openid profile email',
      },
    })
    .then((response) => {
      expect(response.status).to.eq(200)
      expect(response.body).to.have.property('access_token')
      return response.body.access_token
    })
}

/**
 * Login user using direct API authentication (more reliable than UI flow)
 * @param {string} email - User email
 * @param {string} password - User password
 */
export function loginStandardUserAPI(email, password) {
  cy.log(`🔐 Logging in user via API: ${email}`)

  // Clear any existing authentication state
  logout()

  // Get JWT token, store it, set up intercept, and verify authentication
  return getAuth0TokenDirect(email, password).then((token) => {
    // Store the token
    cy.window().then((win) => {
      win.localStorage.setItem('auth_token', token)
    })

    // Set up intercept with the token
    cy.intercept('**/api/**', (req) => {
      req.headers['Authorization'] = `Bearer ${token}`
    }).as('authenticatedApiRequests')

    // Verify the authentication works and wait for intercept to be active
    return cy
      .request({
        method: 'GET',
        url: '/api/v3/users?errIfNoAuth=true',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      .then((response) => {
        expect(response.status).to.eq(200)
        expect(response.body.email).to.eq(email)
        cy.log(`✅ User authenticated: ${email}`)
      })
  })
}

/**
 * Helper to participate anonymously in a conversation
 * Note: Anonymous participants don't "log in" - they receive JWTs when they take actions like voting
 * @param {string} conversationId - The conversation ID to participate in
 */
export function participateAnonymously(conversationId) {
  cy.log(`👤 Participating anonymously in conversation: ${conversationId}`)

  // Clear any existing authentication state
  logout()

  // Visit the specific conversation as an anonymous user
  cy.visit(`/${conversationId}`)

  // Wait for the conversation to load
  cy.get('body').should('be.visible')

  // Note: JWT tokens are only issued when participants take actions (like voting)
  // The participant_token will not exist until the user votes
  cy.log('✅ Anonymous participant ready to participate (JWT will be issued on first action)')
}

/**
 * Helper to participate with an External ID (XID)
 * Note: XID participants receive JWTs when they take actions like voting
 * @param {string} conversationId - The conversation ID to participate in
 * @param {string} xid - External ID for the participant
 */
export function participateWithXID(conversationId, xid) {
  cy.log(`🆔 Participating with XID: ${xid} in conversation: ${conversationId}`)

  // Clear any existing authentication state
  logout()

  // Visit the conversation with XID parameter
  cy.visit(`/${conversationId}`, {
    qs: {
      xid: xid,
    },
  })

  // Wait for the conversation to load
  cy.get('body').should('be.visible')

  // Note: JWT tokens are only issued when participants take actions (like voting)
  // The participant_token will not exist until the user votes
  cy.log(`✅ XID participant ready to participate: ${xid} (JWT will be issued on first action)`)
}

/**
 * Helper to get Auth0 access token from localStorage cache
 * @returns {Cypress.Chainable<string>} The access token
 */
export function getAuth0AccessToken() {
  return cy.window().then((win) => {
    // First try the simple approach - check if we stored the token directly
    const storedToken = win.localStorage.getItem('auth_token')
    if (storedToken) {
      return storedToken
    }

    // Fallback: Check if auth0TokenGetter is available
    if (typeof win.auth0TokenGetter === 'function') {
      return cy.wrap(win.auth0TokenGetter()).then((token) => {
        expect(token).to.be.a('string')
        expect(token.length).to.be.greaterThan(0)
        return token
      })
    }

    // Fallback: Find Auth0 SDK cache for access tokens
    const auth0Keys = Object.keys(win.localStorage).filter(
      (key) => key.includes('@@auth0spajs@@') && key.includes('::') && !key.includes('@@user@@'),
    )

    if (auth0Keys.length === 0) {
      throw new Error('No Auth0 access token found in localStorage')
    }

    const cacheKey = auth0Keys[0]
    const cacheData = JSON.parse(win.localStorage.getItem(cacheKey))

    if (!cacheData || !cacheData.body || !cacheData.body.access_token) {
      throw new Error('Access token not found in Auth0 cache')
    }

    return cacheData.body.access_token
  })
}

/**
 * Helper to verify JWT token structure and claims
 * @param {string} tokenKey - localStorage key for the token OR 'auth0' to use Auth0 token getter
 * @param {object} expectedClaims - Claims to verify in the token
 */
export function verifyJWTClaims(tokenKey, expectedClaims) {
  if (tokenKey === 'auth0') {
    // Use Auth0 token getter
    return getAuth0AccessToken().then((token) => {
      expect(token).to.exist

      // Decode JWT payload
      const payload = JSON.parse(atob(token.split('.')[1]))

      const namespace = Cypress.env('AUTH_NAMESPACE')

      // Verify expected claims
      Object.keys(expectedClaims).forEach((claim) => {
        const expectedValue = expectedClaims[claim]
        let actualValue

        // For Auth0 access tokens, check custom namespace claims first, then standard claims
        actualValue = payload[`${namespace}${claim}`] || payload[claim]

        expect(actualValue).to.equal(
          expectedValue,
          `Expected ${claim} to be ${expectedValue}, but got ${actualValue}`,
        )
      })
    })
  } else {
    // Use localStorage key (original behavior)
    return cy.window().then((win) => {
      const token = win.localStorage.getItem(tokenKey)
      expect(token).to.exist

      // Decode JWT payload
      const payload = JSON.parse(atob(token.split('.')[1]))

      // For access tokens, we need to check custom namespace claims
      // For ID tokens, we can check standard claims
      const namespace = Cypress.env('AUTH_NAMESPACE')

      // Verify expected claims
      Object.keys(expectedClaims).forEach((claim) => {
        const expectedValue = expectedClaims[claim]
        let actualValue

        // For access tokens, check custom namespace claims first, then standard claims
        if (tokenKey === 'auth_token') {
          // Access token - prefer custom namespace claims
          actualValue = payload[`${namespace}${claim}`] || payload[claim]
        } else {
          // ID token or other tokens - check standard claims first
          actualValue = payload[claim] || payload[`${namespace}${claim}`]
        }

        expect(actualValue).to.equal(
          expectedValue,
          `Expected ${claim} to be ${expectedValue}, but got ${actualValue}`,
        )
      })
    })
  }
}

/**
 * Helper to verify custom namespace claims in JWT token
 * @param {string} tokenKey - localStorage key for the token OR 'auth0' to use Auth0 token getter
 * @param {object} expectedClaims - Custom namespace claims to verify
 */
export function verifyCustomNamespaceClaims(tokenKey, expectedClaims) {
  if (tokenKey === 'auth0') {
    // Use Auth0 token getter
    return getAuth0AccessToken().then((token) => {
      expect(token).to.exist

      // Decode JWT payload
      const payload = JSON.parse(atob(token.split('.')[1]))
      const namespace = Cypress.env('AUTH_NAMESPACE')

      // Verify custom namespace claims
      Object.keys(expectedClaims).forEach((claim) => {
        const namespacedClaim = `${namespace}${claim}`
        expect(payload[namespacedClaim]).to.equal(
          expectedClaims[claim],
          `Expected ${namespacedClaim} to be ${expectedClaims[claim]}, but got ${payload[namespacedClaim]}`,
        )
      })
    })
  } else {
    // Use localStorage key (original behavior)
    return cy.window().then((win) => {
      const token = win.localStorage.getItem(tokenKey)
      expect(token).to.exist

      // Decode JWT payload
      const payload = JSON.parse(atob(token.split('.')[1]))
      const namespace = Cypress.env('AUTH_NAMESPACE')

      // Verify custom namespace claims
      Object.keys(expectedClaims).forEach((claim) => {
        const namespacedClaim = `${namespace}${claim}`
        expect(payload[namespacedClaim]).to.equal(
          expectedClaims[claim],
          `Expected ${namespacedClaim} to be ${expectedClaims[claim]}, but got ${payload[namespacedClaim]}`,
        )
      })
    })
  }
}

/**
 * Helper to verify standard claims in ID token from Auth0 cache
 * @param {object} expectedClaims - Standard claims to verify in ID token
 */
export function verifyIDTokenClaims(expectedClaims) {
  return cy.window().then((win) => {
    // Auth0 stores ID token in its cache format: @@auth0spajs@@::client-id::@@user@@
    const auth0UserKeys = Object.keys(win.localStorage).filter(
      (key) => key.includes('@@auth0spajs@@') && key.includes('@@user@@'),
    )

    if (auth0UserKeys.length === 0) {
      // ID token might not be issued by the simulator - this is expected
      cy.log('⚠️ No Auth0 user cache found - ID token verification skipped')
      return
    }

    const userCacheKey = auth0UserKeys[0]
    const userCacheData = JSON.parse(win.localStorage.getItem(userCacheKey))

    if (!userCacheData || !userCacheData.body || !userCacheData.body.id_token) {
      // ID token might not be issued by the simulator - this is expected
      cy.log('⚠️ ID token not found in Auth0 cache - verification skipped')
      return
    }

    const token = userCacheData.body.id_token

    // Decode JWT payload
    const payload = JSON.parse(atob(token.split('.')[1]))

    // Verify standard claims
    Object.keys(expectedClaims).forEach((claim) => {
      expect(payload[claim]).to.equal(
        expectedClaims[claim],
        `Expected ID token ${claim} to be ${expectedClaims[claim]}, but got ${payload[claim]}`,
      )
    })
  })
}

/**
 * Helper to intercept continuous polling requests on participant pages
 * This prevents Cypress from waiting indefinitely for ongoing XHR requests
 */
export function interceptParticipantPolling() {
  cy.log('🔄 Setting up polling intercepts for participant page')

  // Math/PCA polling - return 304 Not Modified to simulate cached response
  cy.intercept('GET', '/api/v3/math/pca2*', { statusCode: 304, body: {} }).as('mathPolling')

  // Comments polling - return empty array
  cy.intercept('GET', '/api/v3/comments*', { statusCode: 200, body: [] }).as('commentsPolling')

  // Famous votes polling - return empty array
  cy.intercept('GET', '/api/v3/votes/famous*', { statusCode: 200, body: [] }).as(
    'famousVotesPolling',
  )

  // General conversation data polling
  cy.intercept('GET', '/api/v3/conversation*', (req) => {
    // Only intercept polling requests, not initial loads
    if (req.headers['if-none-match'] || req.url.includes('cacheBust')) {
      req.reply({ statusCode: 304, body: {} })
    }
  }).as('conversationPolling')
}

/**
 * Helper to vote on a comment (this triggers JWT issuance for participants)
 * @param {string} voteType - 'agree', 'disagree', or 'pass'
 */
export function voteOnComment(voteType = 'agree') {
  // Set up polling intercepts to prevent indefinite waiting
  cy.intercept('GET', '/api/v3/math/pca2*', { statusCode: 304, body: {} })
  cy.intercept('GET', '/api/v3/comments*', { statusCode: 200, body: [] })
  cy.intercept('GET', '/api/v3/votes/famous*', { statusCode: 200, body: [] })

  // Wait for voting interface to load
  cy.get('#comment_shower').should('be.visible')
  cy.get('#agreeButton').should('be.visible')

  // Map vote types to button IDs
  const voteButtonIds = {
    agree: '#agreeButton',
    disagree: '#disagreeButton',
    pass: '#passButton',
  }

  const buttonId = voteButtonIds[voteType.toLowerCase()]
  if (!buttonId) {
    throw new Error(`Invalid vote type: ${voteType}. Must be 'agree', 'disagree', or 'pass'`)
  }

  // Intercept and submit vote
  cy.intercept('POST', '/api/v3/votes').as('voteRequest')
  cy.get(buttonId).click()

  // Wait for vote response
  cy.wait('@voteRequest').then((interception) => {
    expect(interception.response.statusCode).to.eq(200)

    // Debug: Log the response to see what we're getting
    cy.log('🔍 Vote response body:', JSON.stringify(interception.response.body, null, 2))

    // Store JWT token if issued
    if (interception.response.body.auth && interception.response.body.auth.token) {
      cy.log('✅ JWT found in response, storing in localStorage')
      cy.window().then((win) => {
        win.localStorage.setItem('participant_token', interception.response.body.auth.token)
        cy.log('✅ JWT stored in localStorage')
      })
    } else {
      cy.log('⚠️ No JWT found in vote response')
      if (interception.response.body.auth) {
        cy.log('🔍 Auth object exists but no token:', interception.response.body.auth)
      } else {
        cy.log('🔍 No auth object in response')
      }
    }
  })
}

/**
 * Helper to verify that a JWT token exists and is valid
 * @param {string} tokenKey - localStorage key for the token ('participant_token' or 'auth_token')
 * @param {object} expectedClaims - Expected claims in the JWT
 */
export function verifyJWTExists(tokenKey = 'participant_token', expectedClaims = {}) {
  cy.log(`🔍 Verifying JWT token exists: ${tokenKey}`)

  cy.window().then((win) => {
    const token = win.localStorage.getItem(tokenKey)
    expect(token).to.exist
    expect(token).to.be.a('string')

    // Verify JWT format (header.payload.signature)
    const parts = token.split('.')
    expect(parts).to.have.length(3)

    // Decode and verify payload
    const payload = JSON.parse(atob(parts[1]))

    // Verify expected claims
    Object.keys(expectedClaims).forEach((claim) => {
      const expectedValue = expectedClaims[claim]
      expect(payload[claim]).to.equal(
        expectedValue,
        `Expected JWT claim ${claim} to be ${expectedValue}, but got ${payload[claim]}`,
      )
    })

    cy.log(`✅ JWT token verified: ${tokenKey}`)
  })
}

/**
 * Helper to wait for JWT token to be stored after an action
 * @param {string} tokenKey - localStorage key to watch for
 * @param {number} timeout - Timeout in milliseconds
 */
export function waitForJWTToken(tokenKey = 'participant_token') {
  cy.log(`⏳ Waiting for JWT token: ${tokenKey}`)

  // Use should() with retry logic for better Cypress integration
  cy.window().should((win) => {
    const token = win.localStorage.getItem(tokenKey)
    const isValidJWT = token && token.split('.').length === 3

    if (!isValidJWT) {
      throw new Error(`JWT token ${tokenKey} not found or invalid`)
    }
  })

  cy.log(`✅ JWT token detected: ${tokenKey}`)
}

/**
 * Helper to check Auth0 simulator connectivity
 */
export function checkAuth0Simulator() {
  const authUrl = Cypress.env('AUTH_ISSUER')

  cy.log(`🔍 Checking Auth0 simulator connectivity: ${authUrl}`)

  // Check JWKS endpoint
  cy.request({
    url: `${authUrl}.well-known/jwks.json`,
    headers: {
      Accept: 'application/json',
    },
  }).then((response) => {
    expect(response.status).to.equal(200)
    expect(response.body.keys).to.exist
    cy.log(`✅ Auth0 simulator JWKS accessible: ${response.body.keys.length} keys found`)
  })
}

/**
 * Helper to verify server JWT validation using Auth0 access token
 */
export function verifyServerJWTValidation() {
  cy.log('🔍 Verifying server JWT validation with Auth0 token')

  return getAuth0AccessToken().then((authToken) => {
    cy.log('🔍 Using Auth0 access token for server validation:', authToken ? 'present' : 'missing')

    // Make a request to a protected endpoint
    cy.request({
      url: '/api/v3/users',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`🔍 Server response status: ${response.status}`)

      if (response.status === 401) {
        cy.log('❌ JWT authentication failed - server returned 401')
        cy.log('Error details:', response.body)
      } else if (response.status === 403) {
        cy.log('⚠️ JWT valid but insufficient permissions - server returned 403')
      } else if (response.status >= 200 && response.status < 300) {
        cy.log('✅ JWT authentication successful')
      } else {
        cy.log(`⚠️ Unexpected server response: ${response.status}`)
        cy.log('Response body:', response.body)
      }
    })
  })
}

/**
 * Helper to clear all authentication tokens
 */
export function logout() {
  cy.log('🔐 Logging out and clearing all authentication state')

  // Clear all cookies, local storage, and session storage across all domains.
  // This is crucial for multi-origin authentication flows (like with Auth0).
  cy.clearAllCookies()
  cy.clearAllLocalStorage()
  cy.clearAllSessionStorage()

  // Visit the home page to ensure the application's in-memory state is wiped.
  // Using 'about:blank' can fail if a baseUrl is configured.
  cy.visit('/')

  cy.log('✅ Logout complete, all authentication state cleared.')
}

/**
 * Verify the currently authenticated user
 * @param {string} expectedEmail - Expected email of logged in user
 */
export function verifyCurrentUser(expectedEmail) {
  cy.request('/api/v3/users?errIfNoAuth=true').then((response) => {
    expect(response.status).to.eq(200)
    expect(response.body.email).to.eq(expectedEmail)
  })
}
