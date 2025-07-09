/**
 * Test for anonymous participation JWT flow
 * Verifies that anonymous participants receive JWT tokens when they vote
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Anonymous Participation JWT Flow', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Test Anonymous JWT Flow',
      description: 'Testing anonymous participation with JWT',
      comments: ['Test comment 1', 'Test comment 2', 'Test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('should issue JWT on first vote for anonymous participant', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Wait for page to load
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // Use the working pattern from debug-jwt-flow
    let jwtTokenFromResponse = null

    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        // Check response
        expect(res.statusCode).to.eq(200)

        const body = res.body
        expect(body.currentPid).to.exist

        // Check for JWT
        if (body.auth && body.auth.token) {
          console.log('✅ JWT found in vote response')
          jwtTokenFromResponse = body.auth.token

          // Verify JWT format
          const parts = body.auth.token.split('.')
          expect(parts).to.have.length(3)

          // Decode payload
          const payload = JSON.parse(atob(parts[1]))
          expect(payload.anonymous).to.be.true
          expect(payload.sub).to.match(/^anon:/)
          console.log('✅ JWT has correct anonymous claims')
        } else {
          throw new Error('Expected JWT in vote response but none was found')
        }
      })
    }).as('vote')

    // Click vote button
    cy.get('#agreeButton').click()

    // Wait for vote
    cy.wait('@vote')

    // Check localStorage after vote
    cy.wait(1000).then(() => {
      cy.window().then((win) => {
        const token = win.localStorage.getItem('participant_token')
        expect(token).to.exist
        expect(token).to.equal(jwtTokenFromResponse)
        console.log('✅ JWT stored in localStorage and matches response')
      })
    })
  })

  it('should persist JWT across page reloads', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Visit and vote
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')
    cy.get('#agreeButton').click()

    // Wait for JWT
    cy.wait(1000)

    // Get token
    cy.window().then((win) => {
      const token = win.localStorage.getItem('participant_token')
      expect(token).to.exist

      // Reload
      cy.reload()

      // Check persistence
      cy.window().then((newWin) => {
        const persistedToken = newWin.localStorage.getItem('participant_token')
        expect(persistedToken).to.equal(token)
        console.log('✅ JWT persisted across reload')
      })
    })
  })
})
