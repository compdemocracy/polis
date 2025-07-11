/**
 * Debug test for anonymous JWT flow
 * This test includes extensive logging to identify why JWT isn't being received
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Debug Anonymous JWT Flow', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Debug JWT Flow',
      description: 'Debug test for JWT',
      comments: ['Test comment 1', 'Test comment 2'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('debug JWT flow step by step', function () {
    // Clear everything
    cy.clearLocalStorage()
    cy.window().then((win) => {
      win.sessionStorage.clear()
    })

    // Intercept and log ALL headers for debugging
    cy.intercept('GET', '/api/v3/participationInit*', (req) => {
      console.log('📝 participationInit request headers:', JSON.stringify(req.headers, null, 2))
      console.log('📝 participationInit request URL:', req.url)
      req.continue((res) => {
        console.log('📝 participationInit response status:', res.statusCode)
        console.log('📝 participationInit response body:', JSON.stringify(res.body, null, 2))
      })
    }).as('participationInit')

    cy.intercept('POST', '/api/v3/votes', (req) => {
      console.log('🗳️ VOTE REQUEST:')
      console.log('  Headers:', JSON.stringify(req.headers, null, 2))
      console.log('  Body:', JSON.stringify(req.body, null, 2))
      console.log('  URL:', req.url)
      console.log('  Method:', req.method)

      // Check specifically for authorization header
      if (req.headers.authorization) {
        console.log('  ⚠️ Authorization header present:', req.headers.authorization)
      } else {
        console.log('  ✅ No authorization header (as expected for first vote)')
      }

      // Check for cookies
      if (req.headers.cookie) {
        console.log('  🍪 Cookies:', req.headers.cookie)
      } else {
        console.log('  ✅ No cookies')
      }

      req.continue((res) => {
        console.log('🗳️ VOTE RESPONSE:')
        console.log('  Status:', res.statusCode)
        console.log('  Headers:', JSON.stringify(res.headers, null, 2))
        console.log('  Body:', JSON.stringify(res.body, null, 2))

        if (res.body.auth && res.body.auth.token) {
          console.log('  ✅ JWT TOKEN FOUND IN RESPONSE!')
          console.log('  Token:', res.body.auth.token)
        } else {
          console.log('  ❌ NO JWT IN RESPONSE')
          console.log('  Response keys:', Object.keys(res.body))
        }
      })
    }).as('voteRequest')

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Wait for participation init
    cy.wait('@participationInit')

    // Check current state before voting
    cy.window().then((win) => {
      console.log('📋 BEFORE VOTE - Window state:')
      console.log('  localStorage keys:', Object.keys(win.localStorage))
      console.log('  sessionStorage keys:', Object.keys(win.sessionStorage))

      // Check if there's any auth state
      const token =
        win.localStorage.getItem('participant_token') ||
        win.sessionStorage.getItem('participant_token')
      if (token) {
        console.log('  ⚠️ Found existing token:', token)
      } else {
        console.log('  ✅ No existing auth tokens')
      }
    })

    // Check cookies
    cy.getCookies().then((cookies) => {
      console.log(
        '🍪 Current cookies:',
        cookies.map((c) => c.name),
      )
      if (cookies.length > 0) {
        cookies.forEach((cookie) => {
          console.log(`  ${cookie.name}:`, cookie.value)
        })
      } else {
        console.log('  ✅ No cookies set')
      }
    })

    // Wait for UI to be ready
    cy.get('#comment_shower', { timeout: 10000 }).should('be.visible')
    cy.get('#comment_shower p[lang]', { timeout: 10000 })
      .should('be.visible')
      .should('not.be.empty')
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').should('not.be.disabled')

    // Vote
    cy.log('🗳️ Casting vote')
    cy.get('#agreeButton').click()

    // Wait for vote response
    cy.wait('@voteRequest').then(() => {
      console.log('📋 Vote interception complete')

      // Check localStorage after vote
      cy.window().then((win) => {
        console.log('📋 AFTER VOTE - Window state:')
        console.log('  localStorage keys:', Object.keys(win.localStorage))
        console.log('  sessionStorage keys:', Object.keys(win.sessionStorage))

        const token =
          win.localStorage.getItem('participant_token') ||
          win.sessionStorage.getItem('participant_token')
        if (token) {
          console.log('  ✅ Found JWT token after vote:', token.substring(0, 50) + '...')
        } else {
          console.log('  ❌ Still no JWT token after vote')
        }
      })
    })

    // Final check
    cy.wait(1000).then(() => {
      cy.task('log', '=== FINAL CHECK ===')
      cy.window().then((win) => {
        const finalToken =
          win.localStorage.getItem('participant_token')
        if (finalToken) {
          cy.task('log', '✅ JWT successfully stored in localStorage')
          expect(finalToken).to.exist
        } else {
          cy.task('log', '❌ No JWT found in localStorage')
          throw new Error('Expected JWT to be stored but none was found')
        }
      })
    })
  })
})
