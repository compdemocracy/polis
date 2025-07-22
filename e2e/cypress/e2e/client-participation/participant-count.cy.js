import { loginStandardUserAPI, logout, getAuthToken } from '../../support/auth-helpers.js'

describe('Participant Count Test', function () {
  it('creates and counts participants correctly', function () {
    let testConversationId

    // Phase 1: Admin actions (in isolated window context)
    cy.window().then(() => {
      // Login as admin
      loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')

      getAuthToken().then((token) => {
        // Create conversation
        cy.request({
          method: 'POST',
          url: '/api/v3/conversations',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: {
            topic: 'Admin Count Test',
            description: 'Testing if admin is counted as participant',
            is_anon: true,
            is_active: true,
            vis_type: 1, // Enable visualization
          },
        })
          .then((response) => {
            const conversationId = response.body.conversation_id
            testConversationId = conversationId
            cy.log(`Created conversation: ${conversationId}`)

            // Add comments
            const comments = ['Comment 1', 'Comment 2', 'Comment 3']

            // Create a chain of comment creation requests
            comments.forEach((comment) => {
              cy.request({
                method: 'POST',
                url: '/api/v3/comments',
                headers: {
                  Authorization: `Bearer ${token}`,
                },
                body: {
                  conversation_id: conversationId,
                  txt: comment,
                  is_seed: true,
                },
              })
            })

            return cy.wrap(conversationId)
          })
          .then((conversationId) => {
            // Check participant count immediately after creation
            cy.request({
              method: 'GET',
              url: `/api/v3/conversations?conversation_id=${conversationId}`,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }).then((response) => {
              const count = response.body?.participant_count || 0
              cy.log(`📊 Participant count after creation: ${count}`)

              cy.log('✅ Admin IS being counted as a participant!')
              expect(count).to.equal(1, 'Admin should be participant 1')

              // Now logout and check as anonymous
              logout()

              cy.request({
                method: 'GET',
                url: `/api/v3/conversations?conversation_id=${conversationId}`,
                failOnStatusCode: false,
              }).then((anonResponse) => {
                const anonCount = anonResponse.body?.participant_count || 0
                cy.log(`📊 Participant count as anonymous: ${anonCount}`)
              })
            })
          })
      })
    })

    // Phase 2: Reset browser context completely before participant actions
    cy.then(() => {
      cy.log('🔄 Resetting browser context for participant phase')

      // Visit a neutral page first to establish clean context
      cy.visit('/')

      // Continue with participant creation
      cy.log(`Testing participant creation with conversation: ${testConversationId}`)

      // Create Participant 1 (anonymous)
      cy.log('👤 Creating Participant 1 (anonymous)')

      // Verify clean state before voting
      cy.window().then((win) => {
        // Check if any auth tokens exist
        const hasOidcUser = Object.keys(win.localStorage).some((key) =>
          key.startsWith('oidc.user:'),
        )
        const participantToken = win.localStorage.getItem(`participant_token_${testConversationId}`)
        cy.log(`🔍 Before voting - OIDC user exists: ${hasOidcUser ? 'YES' : 'NO'}`)
        cy.log(`🔍 Before voting - Participant token: ${participantToken ? 'EXISTS' : 'NONE'}`)
      })

      // Track vote requests to detect sticky auth headers
      let voteRequestData = {}
      cy.intercept('POST', '/api/v3/votes', (req) => {
        voteRequestData = {
          hasAuth: !!(req.headers.authorization || req.headers.Authorization),
          authHeader: req.headers.authorization || req.headers.Authorization,
          body: req.body,
        }

        req.continue((res) => {
          voteRequestData.response = res.body
          voteRequestData.responseStatus = res.statusCode
        })
      }).as('voteDebug')

      cy.visit(`/${testConversationId}`)

      // Vote on the first comment (this creates the participant)
      cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()

      cy.wait('@voteDebug').then(() => {
        if (voteRequestData.hasAuth) {
          cy.log('⚠️ WARNING: Auth header found in anonymous vote request!')
          cy.log(`🔍 Auth header: ${voteRequestData.authHeader?.substring(0, 50)}...`)
        } else {
          cy.log('✅ Vote request has no auth header - good!')
        }
        cy.log(`🔍 Vote response status: ${voteRequestData.responseStatus}`)
        if (voteRequestData.response?.currentPid) {
          cy.log(`🔍 Server assigned PID: ${voteRequestData.response.currentPid}`)
        }
      })

      // Check count after first participant
      cy.request({
        method: 'GET',
        url: `/api/v3/conversations?conversation_id=${testConversationId}`,
        failOnStatusCode: false,
      }).then((response) => {
        const count = response.body?.participant_count || 0
        cy.log(`📊 After 1 anonymous participant: ${count}`)
        expect(count).to.be.at.least(
          2,
          'Should have at least 2 participants (admin + 1 participant)',
        )
      })

      // Create Participant 2 (with XID)
      cy.log('👤 Creating Participant 2 (with XID)')

      cy.clearLocalStorage()

      const xid = `test-xid-${Date.now()}`
      cy.visit(`/${testConversationId}?xid=${xid}`)

      // Vote on the first comment (this creates the XID participant)
      cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()

      cy.wait('@voteDebug').then(() => {
        if (voteRequestData.hasAuth) {
          cy.log('⚠️ WARNING: Auth header found in XID participant vote request!')
          cy.log(`🔍 Auth header: ${voteRequestData.authHeader?.substring(0, 50)}...`)
        } else {
          cy.log('✅ XID vote request has no auth header - good!')
        }
        if (voteRequestData.response?.currentPid) {
          cy.log(`🔍 XID participant assigned PID: ${voteRequestData.response.currentPid}`)
        }
      })

      // Check final count
      cy.request({
        method: 'GET',
        url: `/api/v3/conversations?conversation_id=${testConversationId}`,
        failOnStatusCode: false,
      }).then((response) => {
        const count = response.body?.participant_count || 0
        cy.log(`📊 After 2 participants (1 anon + 1 XID): ${count}`)
        expect(count).to.be.at.least(3, 'Should have at least 3 participants (admin + anon + XID)')
      })
    })
  })
})
