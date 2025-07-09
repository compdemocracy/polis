/**
 * Debug test to understand participant counting issues
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Debug Participant Count', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Debug Participant Count Test',
      description: 'Debugging why participants are not counted',
      comments: ['Test comment 1', 'Test comment 2'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Created conversation: ${conversationId}`)
    })
  })

  it('logs detailed participant creation info', function () {
    cy.log('🔍 Testing participant creation and counting')

    // Check initial count
    cy.request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`📊 Initial participant count: ${response.body?.participant_count || 0}`)
    })

    // Create first participant
    cy.log('👤 Creating Participant 1')

    // Clear all auth
    cy.clearLocalStorage()
    cy.window().then((win) => win.sessionStorage.clear())

    // Track auth headers
    let voteRequestData = {}
    cy.intercept('POST', '/api/v3/votes', (req) => {
      // Store data for logging outside the callback
      voteRequestData = {
        headers: req.headers,
        body: req.body,
        hasAuth: !!(req.headers.authorization || req.headers.Authorization),
      }

      req.continue((res) => {
        voteRequestData.response = res.body
        voteRequestData.responseStatus = res.statusCode
      })
    }).as('voteDebug')

    // Visit and vote
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()
    cy.wait('@voteDebug').then(() => {
      cy.log('🔍 Vote request data:', JSON.stringify(voteRequestData, null, 2))
      if (voteRequestData.hasAuth) {
        cy.log('⚠️ WARNING: Auth header found in vote request!')
      }
    })

    // Check count after first participant
    cy.wait(1000)
    cy.request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`📊 After participant 1: ${response.body?.participant_count || 0} participants`)
    })

    // Create second participant with XID
    cy.log('👤 Creating Participant 2 (with XID)')

    cy.clearLocalStorage()
    cy.window().then((win) => win.sessionStorage.clear())

    const xid = `test-xid-${Date.now()}`
    cy.visit(`/${conversationId}?xid=${xid}`)
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()
    cy.wait('@voteDebug').then(() => {
      cy.log('🔍 Vote request data (participant 2):', JSON.stringify(voteRequestData, null, 2))
      if (voteRequestData.hasAuth) {
        cy.log('⚠️ WARNING: Auth header found in participant 2 vote request!')
      }
    })

    // Check count after second participant
    cy.wait(1000)
    cy.request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`📊 After participant 2: ${response.body?.participant_count || 0} participants`)
    })

    // Try a raw API vote to see if UI is the issue
    cy.log('🔍 Testing raw API vote')

    cy.request({
      method: 'POST',
      url: '/api/v3/votes',
      body: {
        conversation_id: conversationId,
        tid: 0, // First comment
        vote: 1, // Agree
        pid: -1, // New participant
        xid: `api-test-xid-${Date.now()}`,
      },
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`🔍 Raw API vote response:`, JSON.stringify(response.body))
      cy.log(`📊 Response status: ${response.status}`)
    })

    // Final count check
    cy.wait(1000)
    cy.request({
      method: 'GET',
      url: `/api/v3/conversations?conversation_id=${conversationId}`,
      failOnStatusCode: false,
    }).then((response) => {
      const finalCount = response.body?.participant_count || 0
      cy.log(`📊 Final participant count: ${finalCount}`)
      cy.log(`📊 Full conversation data:`, JSON.stringify(response.body, null, 2))

      // Add assertions to see the counts in output
      expect(finalCount, 'Final participant count').to.be.at.least(1)

      // Log summary
      cy.log('📊 SUMMARY:')
      cy.log(`- Expected at least 3 participants (2 UI + 1 API)`)
      cy.log(`- Actual count: ${finalCount}`)

      if (finalCount < 3) {
        cy.log('⚠️ Participant count is lower than expected!')
        cy.log('Possible reasons:')
        cy.log('1. Admin user is being counted as participant')
        cy.log('2. Auth headers are interfering')
        cy.log('3. XID participants not being created separately')
      }
    })
  })
})
