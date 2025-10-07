/**
 * Conversation helpers for Polis E2E tests
 * Provides utilities for creating and managing conversations for participant testing
 */

import { loginStandardUser, loginStandardUserAPI, getAuthToken } from './auth-helpers.js'

/**
 * Helper to create a test conversation via API (for API auth tests)
 * @param {Object} options - Conversation options
 * @param {string} options.topic - Conversation topic
 * @param {string} options.description - Conversation description
 * @param {boolean} options.visualizationEnabled - Whether to enable visualization
 * @returns {Cypress.Chainable<string>} - Conversation ID
 */
export function createTestConversationAPI(options = {}) {
  const {
    topic = `Test Conversation ${Date.now()}`,
    description = `Test conversation created via API at ${new Date().toISOString()}`,
    visualizationEnabled = false,
  } = options

  cy.log(`🏗️ Creating test conversation via API: ${topic}`)

  // Create conversation via API using stored token
  return getAuthToken()
    .then((token) => {
      return cy.request({
        method: 'POST',
        url: '/api/v3/conversations',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          topic: topic,
          description: description,
          is_anon: true,
          is_active: true,
          vis_type: visualizationEnabled ? 1 : 0,
        },
      })
    })
    .then((response) => {
      expect(response.status).to.eq(200)
      const conversationId = response.body.conversation_id
      if (visualizationEnabled) {
        cy.log(`✅ Created conversation with visualization enabled: ${conversationId}`)
      } else {
        cy.log(`✅ Created conversation: ${conversationId}`)
      }
      return cy.wrap(conversationId)
    })
}

/**
 * Create a test conversation using the robust UI-based approach from admin tests
 * @param {Object} options - Conversation options
 * @param {string} options.topic - Conversation topic
 * @param {string} options.description - Conversation description
 * @param {string} options.userEmail - Email of user to create conversation (defaults to moderator)
 * @param {string} options.userPassword - Password of user to create conversation
 * @param {boolean} options.is_anon - Whether conversation allows anonymous participation
 * @param {boolean} options.is_active - Whether conversation is active
 * @returns {Cypress.Chainable<string>} - Conversation ID
 */
export function createTestConversation(options = {}) {
  const {
    topic = `Test Conversation ${Date.now()}`,
    description = `Test conversation created for e2e testing at ${new Date().toISOString()}`,
    userEmail = 'moderator@polis.test',
    userPassword = 'Te$tP@ssw0rd*',
  } = options

  cy.log(`🏗️ Creating test conversation via UI: ${topic}`)

  // Login as moderator or specified user
  loginStandardUser(userEmail, userPassword)

  // Navigate to admin dashboard and create conversation
  cy.visit('/')
  cy.get('h3').should('contain.text', 'All Conversations')

  // Click create new conversation
  cy.get('button, a')
    .contains(/create new conversation/i)
    .click()

  // Should navigate to conversation config page
  cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)

  // Wait for the conversation configuration page to fully load
  cy.get('h1, h2, h3').should('contain.text', 'Configure')

  // Wait for the form to be ready - check for the existence of key form elements
  cy.get('input[data-testid="topic"]').should('exist')
  cy.get('textarea[data-testid="description"]').should('exist')

  // Set up API intercepts like the robust admin tests
  cy.intercept('PUT', '/api/v3/conversations').as('updateConversation')

  // Wait for topic input to be enabled and configured before typing
  cy.get('input[data-testid="topic"]')
    .should('exist')
    .should('be.visible')
    .should('not.be.disabled')
    .should('have.attr', 'data-testid', 'topic')

  // Clear and type in separate commands to avoid ESLint error
  cy.get('input[data-testid="topic"]').clear()
  cy.get('input[data-testid="topic"]').type(topic)
  cy.get('input[data-testid="topic"]').blur() // Trigger the onBlur save

  // Wait for description textarea to be enabled before typing
  cy.get('textarea[data-testid="description"]')
    .should('exist')
    .should('be.visible')
    .should('not.be.disabled')
    .should('have.attr', 'data-testid', 'description')

  // Clear and type in separate commands to avoid ESLint error
  cy.get('textarea[data-testid="description"]').clear()
  cy.get('textarea[data-testid="description"]').type(description)
  cy.get('textarea[data-testid="description"]').blur() // Trigger the onBlur save

  // Wait for the actual API call to complete
  cy.wait('@updateConversation').then((interception) => {
    expect(interception.response.statusCode).to.eq(200)
  })

  // Extract and return the conversation ID
  return cy.url().then((url) => {
    const match = url.match(/\/m\/([a-zA-Z0-9]+)$/)
    if (match) {
      const conversationId = match[1]
      cy.log(`✅ Created conversation via UI: ${conversationId}`)
      return cy.wrap(conversationId)
    } else {
      throw new Error('Failed to extract conversation ID from URL')
    }
  })
}

/**
 * Add a single comment to a conversation using API directly
 * @param {string} conversationId - The conversation ID
 * @param {string} text - Comment text
 * @param {string} userEmail - Email of user to add comment (defaults to moderator)
 * @param {string} userPassword - Password of user to add comment
 * @returns {Cypress.Chainable<boolean>} - Success indicator
 */
export function addCommentToConversation(
  conversationId,
  text,
  userEmail = 'moderator@polis.test',
  userPassword = 'Te$tP@ssw0rd*',
) {
  cy.log(`💬 Adding single comment to conversation ${conversationId}: ${text}`)

  // Use API authentication which is more reliable for API calls
  return loginStandardUserAPI(userEmail, userPassword).then(() => {
    return getAuthToken().then((token) => {
      return cy
        .request({
          method: 'POST',
          url: '/api/v3/comments',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: {
            conversation_id: conversationId,
            txt: text,
            is_seed: true,
            // Don't specify pid - let the server create/find the participant automatically
          },
        })
        .then((response) => {
          expect(response.status).to.eq(200)
          cy.log(`✅ Added comment to conversation ${conversationId}`)
          return cy.wrap(true)
        })
    })
  })
}

/**
 * Add multiple comments to a conversation using API directly
 * This is more reliable than the UI approach for test setup
 * @param {string} conversationId - The conversation ID
 * @param {Array<string>} comments - Array of comment texts
 * @param {string} userEmail - Email of user to add comments (defaults to moderator)
 * @param {string} userPassword - Password of user to add comments
 * @returns {Cypress.Chainable<boolean>} - Success indicator
 */
export function addCommentsToConversation(
  conversationId,
  comments,
  userEmail = 'moderator@polis.test',
  userPassword = 'Te$tP@ssw0rd*',
) {
  cy.log(`💬 Adding ${comments.length} comments to conversation ${conversationId} via API`)

  // Use API authentication which is more reliable for API calls
  return loginStandardUserAPI(userEmail, userPassword).then(() => {
    return getAuthToken().then((token) => {
      // Create a chain of API requests for sequential comment creation
      cy.wrap(comments).each((comment, index) => {
        cy.log(`💬 Adding comment ${index + 1}/${comments.length}: ${comment}`)

        cy.request({
          method: 'POST',
          url: '/api/v3/comments',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: {
            conversation_id: conversationId,
            txt: comment,
            is_seed: true,
            // Don't specify pid - let the server create/find the participant automatically
          },
        }).then((response) => {
          expect(response.status).to.eq(200)
          cy.log(
            `✅ Added comment ${index + 1}/${comments.length} to conversation ${conversationId}`,
          )
        })
      })

      cy.log(`✅ All ${comments.length} comments added to conversation ${conversationId}`)
      return cy.wrap(true)
    })
  })
}

/**
 * Add comments to a conversation using existing authentication (no re-auth)
 * Use this when you're already authenticated and don't want the overhead of re-authentication
 * @param {string} conversationId - The conversation ID
 * @param {Array<string>} comments - Array of comment texts
 * @returns {Cypress.Chainable<boolean>} - Success indicator
 */
export function addCommentsToConversationNoAuth(conversationId, comments) {
  cy.log(
    `💬 Adding ${comments.length} comments to conversation ${conversationId} (using existing auth)`,
  )

  return getAuthToken().then((token) => {
    // Create a chain of API requests for sequential comment creation
    cy.wrap(comments).each((comment, index) => {
      cy.log(`💬 Adding comment ${index + 1}/${comments.length}: ${comment}`)

      cy.request({
        method: 'POST',
        url: '/api/v3/comments',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: {
          conversation_id: conversationId,
          txt: comment,
          is_seed: true,
        },
      }).then((response) => {
        expect(response.status).to.eq(200)
        return cy.wrap(null).then(() => {
          cy.log(
            `✅ Added comment ${index + 1}/${comments.length} to conversation ${conversationId}`,
          )
        })
      })
    })

    return cy.wrap(true)
  })
}

/**
 * Enable visualization for a conversation via API
 * @param {string} conversationId - The conversation ID
 * @param {string} userEmail - Email of user with admin access
 * @param {string} userPassword - Password of user with admin access
 * @returns {Cypress.Chainable<boolean>} - Success indicator
 */
function enableVisualizationForConversation(
  conversationId,
  userEmail = 'admin@polis.test',
  userPassword = 'Te$tP@ssw0rd*',
) {
  cy.log(`🎨 Enabling visualization for conversation ${conversationId}`)

  // Ensure we're authenticated
  return loginStandardUserAPI(userEmail, userPassword).then(() => {
    // Get the auth token
    return getAuthToken().then((token) => {
      // First, get the current conversation metadata
      return cy
        .request({
          method: 'GET',
          url: `/api/v3/conversations?conversation_id=${conversationId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        .then((response) => {
          expect(response.status).to.eq(200)
          const conversationData = response.body

          // Update the vis_type field to enable visualization
          const updatedData = {
            ...conversationData,
            vis_type: 1,
          }

          return cy
            .request({
              method: 'PUT',
              url: '/api/v3/conversations',
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
              },
              body: updatedData,
            })
            .then((updateResponse) => {
              expect(updateResponse.status).to.eq(200)
              cy.log(`✅ Visualization enabled for conversation ${conversationId}`)
              return cy.wrap(true)
            })
        })
    })
  })
}

/**
 * Set up a complete test conversation with optional visualization enabled
 * @param {Object} options - Conversation options
 * @param {string} options.topic - Conversation topic
 * @param {string} options.description - Conversation description
 * @param {Array<string>} options.comments - Array of comment texts to add
 * @param {string} options.userEmail - Email of user to create conversation
 * @param {string} options.userPassword - Password of user to create conversation
 * @param {boolean} options.visualizationEnabled - Whether to enable visualization
 * @returns {Cypress.Chainable<Object>} - Object with conversation details
 */
export function setupTestConversation(options = {}) {
  const {
    topic = `E2E Test Conversation ${Date.now()}`,
    description = `Test conversation for e2e participant testing`,
    comments = [
      'This is a test comment for voting',
      'Another test comment',
      'A third comment for comprehensive testing',
    ],
    userEmail = 'moderator@polis.test',
    userPassword = 'Te$tP@ssw0rd*',
    visualizationEnabled = false,
  } = options

  cy.log(`🚀 Setting up complete test conversation: ${topic}`)

  // Use UI approach which we know works from the admin tests
  return createTestConversation({
    topic,
    description,
    userEmail,
    userPassword,
    ...options,
  }).then((conversationId) => {
    // Enable visualization if requested
    if (visualizationEnabled) {
      enableVisualizationForConversation(conversationId, userEmail, userPassword)
    }

    if (comments.length > 0) {
      cy.log(`📝 Adding ${comments.length} comments individually to conversation ${conversationId}`)

      // Add comments one by one using the proper helper
      addCommentsToConversation(conversationId, comments, userEmail, userPassword)
    }

    cy.log(
      `✅ Setup complete - Conversation: ${conversationId} with ${comments.length} comments${
        visualizationEnabled ? ' (visualization enabled)' : ''
      }`,
    )

    return cy.wrap({
      conversationId,
      commentCount: comments.length,
      visualizationEnabled,
      setupComplete: true,
    })
  })
}

/**
 * Get conversation details
 * @param {string} conversationId - The conversation ID
 * @returns {Cypress.Chainable<Object>} - Conversation details
 */
export function getConversationDetails(conversationId) {
  cy.log(`🔍 Fetching conversation details: ${conversationId}`)

  return cy
    .request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
    })
    .then((response) => {
      expect(response.status).to.eq(200)
      expect(response.body).to.have.property('topic')

      const topic = response.body.topic
      cy.log(`✅ Fetched conversation details: ${topic}`)
      return cy.wrap(response.body)
    })
}

/**
 * Check if a conversation exists and is accessible
 * @param {string} conversationId - The conversation ID
 * @returns {Cypress.Chainable<boolean>} - Whether conversation exists
 */
export function conversationExists(conversationId) {
  cy.log(`🔍 Checking if conversation exists: ${conversationId}`)

  return cy
    .request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    })
    .then((response) => {
      const exists = response.status === 200
      cy.log(
        `${exists ? '✅' : '❌'} Conversation ${conversationId} ${exists ? 'exists' : 'does not exist'}`,
      )
      return cy.wrap(exists)
    })
}

/**
 * Visit a conversation as a participant
 * @param {string} conversationId - The conversation ID
 * @param {Object} options - Visit options
 * @param {string} options.xid - External ID for XID participants
 * @param {boolean} options.interceptPolling - Whether to intercept polling requests (default: true)
 */
export function visitConversationAsParticipant(conversationId, options = {}) {
  const { xid, interceptPolling = true } = options

  cy.log(
    `👤 Visiting conversation as participant: ${conversationId}${xid ? ` (XID: ${xid})` : ' (anonymous)'}`,
  )

  // CRITICAL: First visit a neutral page to break any context
  cy.visit('/404', { failOnStatusCode: false })

  // Clear all storage and cookies
  cy.clearCookies()
  cy.clearLocalStorage()
  cy.clearAllSessionStorage()

  // Clear window state
  cy.window().then((win) => {
    win.sessionStorage.clear()
    win.localStorage.clear()
    // Clear any global variables that might hold auth state
    if (win.oidcTokenGetter) delete win.oidcTokenGetter
    if (win.user) delete win.user
    if (win.auth) delete win.auth
  })

  // Log storage state after clearing
  cy.window().then((win) => {
    const localStorageData = {}
    const sessionStorageData = {}

    // Convert storage objects to plain objects for logging
    for (let i = 0; i < win.localStorage.length; i++) {
      const key = win.localStorage.key(i)
      localStorageData[key] = win.localStorage.getItem(key)
    }
    for (let i = 0; i < win.sessionStorage.length; i++) {
      const key = win.sessionStorage.key(i)
      sessionStorageData[key] = win.sessionStorage.getItem(key)
    }
  })

  // Set up polling intercepts if needed
  if (interceptPolling) {
    cy.intercept('GET', '/api/v3/math/pca2*', { statusCode: 304, body: {} }).as('mathPolling')
    cy.intercept('GET', '/api/v3/comments*', { statusCode: 200, body: [] }).as('commentsPolling')
    cy.intercept('GET', '/api/v3/votes/famous*', { statusCode: 200, body: [] }).as(
      'famousVotesPolling',
    )
  }

  const url = `/${conversationId}`
  const visitOptions = {}
  if (xid) visitOptions.qs = { xid }

  cy.visit(url, visitOptions)

  // Wait for the conversation to load
  cy.get('body').should('be.visible')

  // Log current URL and query params
  cy.url().then((currentUrl) => {
    cy.log('Current URL:', currentUrl)
  })

  // After page loads, clear any cached JWT tokens
  cy.window().then((win) => {
    if (win.PolisStorage && win.PolisStorage.clearJwtToken) {
      win.PolisStorage.clearJwtToken()
      cy.log('🧹 Cleared PolisStorage JWT token')
    }
  })

  cy.log(`✅ Visited conversation as participant (clean session)`)
}

/**
 * Participate in a conversation by adding comments as a participant
 * @param {string} conversationId - The conversation ID
 * @param {Object} options - Participation options
 * @param {Array<string>} options.comments - Comments to add
 * @param {string} options.xid - External ID for XID participants (optional)
 * @returns {Cypress.Chainable<Object>} - Object with participation details
 */
export function participateInConversation(conversationId, options = {}) {
  const { comments = [], xid } = options

  cy.log(`👤 Participating in conversation: ${conversationId}`)
  cy.log(`💬 Will add ${comments.length} comment(s)`)

  // Visit conversation as participant
  visitConversationAsParticipant(conversationId, { xid, interceptPolling: false })

  // Intercept comment submissions
  let commentRequestData = {}
  cy.intercept('POST', '/api/v3/comments', (req) => {
    commentRequestData = {
      headers: req.headers,
      body: req.body,
      hasAuth: !!(req.headers.authorization || req.headers.Authorization),
    }

    req.continue((res) => {
      commentRequestData.response = res.body
      commentRequestData.responseStatus = res.statusCode
    })
  }).as('submitComment')

  // Add each comment
  comments.forEach((comment, index) => {
    cy.log(`💬 Adding comment ${index + 1}/${comments.length}: ${comment}`)

    // Find and fill comment form
    cy.get(
      'textarea#comment_form_textarea, textarea[name="comment"], textarea[placeholder*="comment"], textarea',
    )
      .first()
      .should('be.visible')

    // Clear and type comment in separate commands to avoid ESLint error
    cy.get(
      'textarea#comment_form_textarea, textarea[name="comment"], textarea[placeholder*="comment"], textarea',
    )
      .first()
      .clear()

    cy.get(
      'textarea#comment_form_textarea, textarea[name="comment"], textarea[placeholder*="comment"], textarea',
    )
      .first()
      .type(comment)

    // Submit comment
    cy.get('button, input[type="submit"]')
      .contains(/submit/i)
      .click()

    // Wait for submission
    cy.wait('@submitComment').then((interception) => {
      expect(interception.response.statusCode).to.eq(200)
      cy.log(`✅ Comment ${index + 1} submitted`)
    })
  })

  return cy.then(() => {
    cy.log(`✅ Participation complete`)
    return cy.wrap({
      conversationId,
      commentCount: comments.length,
    })
  })
}

/**
 * Visit a conversation with a specific language
 * @param {string} conversationId - The conversation ID
 * @param {string} lang - Language code
 */
export function openTranslated(conversationId, lang) {
  cy.log(`🌐 Opening conversation ${conversationId} in language: ${lang}`)

  // Set up polling intercepts to prevent test hanging
  cy.intercept('GET', '/api/v3/math/pca2*', { statusCode: 304, body: {} }).as('mathPolling')
  cy.intercept('GET', '/api/v3/comments*', { statusCode: 200, body: [] }).as('commentsPolling')
  cy.intercept('GET', '/api/v3/votes/famous*', { statusCode: 200, body: [] }).as(
    'famousVotesPolling',
  )

  cy.visit(`/${conversationId}`, { qs: { ui_lang: lang } })
}

/**
 * Read translation string from client-participation language files
 * @param {string} lang - Language code
 * @param {string} key - Translation key (defaults to 'writePrompt')
 * @returns {Cypress.Chainable<string>} - The translated string
 */
export function readTranslation(lang, key = 'writePrompt') {
  const locales = {
    ar: 'ar',
    bs: 'bs',
    cy: 'cy',
    da: 'da_dk',
    de: 'de_de',
    en: 'en_us',
    el: 'gr',
    es: 'es_la',
    fa: 'fa',
    fr: 'fr',
    fy: 'fy_nl',
    he: 'he',
    hr: 'hr',
    it: 'it',
    ja: 'ja',
    nl: 'nl',
    pt: 'pt_br',
    ro: 'ro',
    ru: 'ru',
    sk: 'sk',
    ta: 'ta',
    tdt: 'tdt',
    uk: 'uk',
    my: 'my',
    ps: 'ps',
    sw: 'sw',
    vi: 'vi',
    'zh-CN': 'zh_Hans',
    'zh-TW': 'zh_Hant',
  }

  const filename = locales[lang]
  if (!filename) {
    throw new Error(`Unknown language code: ${lang}`)
  }

  return cy
    .readFile(`../client-participation/js/strings/${filename}.js`, 'utf8')
    .then((contents) => {
      const regex = new RegExp(`s\\.${key}\\s*=\\s*"([^"]*)";`)
      const match = contents.match(regex)

      if (match) {
        return match[1]
      } else {
        throw new Error(`Failed to match ${key} in file ${filename}.js`)
      }
    })
}
