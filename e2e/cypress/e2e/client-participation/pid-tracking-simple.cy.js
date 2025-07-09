/**
 * Simple test to verify PID tracking is working correctly
 * Uses the same pattern as simple-jwt-test.cy.js which works
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('PID Tracking Verification', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'PID Tracking Test',
      description: 'Testing PID tracking works correctly',
      comments: ['First test comment', 'Second test comment'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Created conversation: ${conversationId}`)
    })
  })

  it('tracks PID correctly (not using hardcoded -1)', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Track what PIDs are used
    let pidHistory = []
    let serverAssignedPid = null

    // Intercept vote requests to log PIDs
    cy.intercept('POST', '/api/v3/votes', (req) => {
      const pid = req.body.pid
      pidHistory.push(pid)
      console.log(`📤 Vote request with PID: ${pid}`)

      req.continue((res) => {
        if (res.body.currentPid !== undefined) {
          serverAssignedPid = res.body.currentPid
          console.log(`📥 Server assigned PID: ${serverAssignedPid}`)
        }
      })
    }).as('vote')

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Wait for vote button to appear
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // First vote
    cy.get('#agreeButton').click()
    cy.wait('@vote')

    // Second vote
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()
    cy.wait('@vote')

    // Check results
    cy.then(() => {
      console.log('📊 PID History:', pidHistory)
      console.log('📊 Server assigned PID:', serverAssignedPid)

      // First vote might be -1 (anonymous user not created yet)
      expect(pidHistory[0]).to.be.oneOf([-1, '-1', serverAssignedPid])

      // Second vote should use the server-assigned PID
      if (pidHistory.length > 1) {
        expect(pidHistory[1]).to.equal(serverAssignedPid)
        expect(pidHistory[1]).to.not.equal(-1)
        expect(pidHistory[1]).to.not.equal('-1')
        cy.log('✅ Client correctly updated PID after server assignment')
      }

      // Server should have assigned a valid PID > 0
      expect(serverAssignedPid).to.be.a('number')
      expect(serverAssignedPid).to.be.greaterThan(0)
      expect(serverAssignedPid).to.not.equal(0, 'Should not be admin PID')

      cy.log(`✅ PID tracking working correctly - assigned PID ${serverAssignedPid}`)
    })
  })

  it('prevents duplicate voting after voting on all comments', function () {
    // Clear storage for fresh test
    cy.clearLocalStorage()

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Vote on both comments
    cy.get('#agreeButton', { timeout: 10000 }).click()
    cy.get('#agreeButton', { timeout: 10000 }).click()

    // Should see "voted on all" message
    cy.contains("You've voted on all", { timeout: 10000 }).should('be.visible')

    // Vote buttons should be hidden
    cy.get('#agreeButton').should('not.exist')
    cy.get('#disagreeButton').should('not.exist')
    cy.get('#passButton').should('not.exist')

    cy.log('✅ Duplicate voting prevented - PID tracking is working')
  })
})
