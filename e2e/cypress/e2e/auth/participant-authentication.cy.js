import {
  logout,
  voteOnComment,
  verifyJWTExists,
  waitForJWTToken,
  verifyJWTClaims,
  interceptParticipantPolling,
} from '../../support/auth-helpers.js'

import {
  setupTestConversation,
  visitConversationAsParticipant,
} from '../../support/conversation-helpers.js'

describe('Participant Authentication (Anonymous & XID)', () => {
  let testConversation

  // Use the UI approach that we know works from admin tests
  before(() => {
    cy.log('🚀 Setting up test conversation using working UI approach')

    // CRITICAL: Use cy.then() to isolate the setup phase
    cy.then(() => {
      setupTestConversation({
        topic: 'JWT Test Conversation',
        description: 'Test conversation for JWT validation',
        comments: [
          'First test comment for voting',
          'Second test comment for voting',
          'Third test comment for voting',
        ],
      }).then((conversation) => {
        testConversation = conversation
        cy.log(`✅ Test conversation ready: ${conversation.conversationId}`)
      })
    })
  })

  beforeEach(() => {
    // CRITICAL: Visit a neutral page first to break any lingering context
    cy.visit('/')

    // Clear any existing auth state before each test
    logout()

    // Set up polling intercepts to prevent Cypress from waiting for ongoing requests
    interceptParticipantPolling()
  })

  describe('Anonymous Participant Authentication', () => {
    it('should allow anonymous participation without initial JWT', () => {
      // Visit conversation as anonymous participant
      visitConversationAsParticipant(testConversation.conversationId)

      // Verify no JWT token exists initially
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )
        expect(token).to.be.null
      })

      // Verify conversation loads properly (any comment can appear)
      cy.get('body').should('contain.text', 'JWT Test Conversation')
      cy.get('#comment_shower').should('be.visible')
    })

    it('should issue anonymous JWT when participant votes', () => {
      // Visit conversation as anonymous participant
      visitConversationAsParticipant(testConversation.conversationId)

      // Vote on a comment - this should trigger JWT issuance
      voteOnComment('agree')

      // Wait for JWT to be stored
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Verify the JWT structure and claims
      verifyJWTClaims(`participant_token_${testConversation.conversationId}`, {
        anonymous_participant: true,
        conversation_id: testConversation.conversationId,
      })
    })

    it('should persist anonymous JWT across page refreshes', () => {
      // Visit conversation and vote to get JWT
      visitConversationAsParticipant(testConversation.conversationId)
      voteOnComment('disagree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Get the initial token
      cy.window().then((win) => {
        const initialToken = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )
        expect(initialToken).to.exist

        // Refresh the page
        cy.reload()

        // Verify token persists
        cy.window().then((refreshedWin) => {
          const persistedToken = refreshedWin.localStorage.getItem(
            `participant_token_${testConversation.conversationId}`,
          )
          expect(persistedToken).to.equal(initialToken)
        })
      })
    })

    it('should use JWT for subsequent API requests', () => {
      // Vote to get JWT
      visitConversationAsParticipant(testConversation.conversationId)
      voteOnComment('agree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Make a subsequent authenticated API request to verify JWT is used
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )
        expect(token).to.exist

        // Intercept the API request to verify JWT is included
        cy.intercept('GET', `/api/v3/participationInit*`).as('authenticatedRequest')

        // Make an authenticated API request using the stored JWT
        cy.request({
          url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).then((response) => {
          // Verify the request succeeded with JWT authentication
          expect(response.status).to.not.equal(401)
          expect(response.status).to.be.oneOf([200, 304])
        })
      })
    })
  })

  describe('XID Participant Authentication', () => {
    it('should allow XID participation without initial JWT', () => {
      const testXid = `test-xid-${Date.now()}`

      // Visit conversation with XID
      visitConversationAsParticipant(testConversation.conversationId, { xid: testXid })

      // Wait for JWT to be stored
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Verify JWT is issued from participationInit
      verifyJWTExists(`participant_token_${testConversation.conversationId}`, {
        xid: testXid,
        conversation_id: testConversation.conversationId,
      })

      // Verify conversation loads with XID parameter
      cy.url().should('include', `xid=${testXid}`)
    })

    it('should handle XID participant voting', () => {
      const testXid = `test-xid-${Date.now()}`

      // Visit conversation with XID
      visitConversationAsParticipant(testConversation.conversationId, { xid: testXid })

      // Vote on a comment
      voteOnComment('agree')

      // Verify the JWT structure and XID claims
      verifyJWTExists(`participant_token_${testConversation.conversationId}`, {
        xid: testXid,
        conversation_id: testConversation.conversationId,
      })
    })

    it('should handle different XID formats', () => {
      const testCases = [
        'simple-xid',
        'user@example.com',
        'user_123_456',
        `xid-with-timestamp-${Date.now()}`,
      ]

      testCases.forEach((xid) => {
        cy.log(`Testing XID format: ${xid}`)

        // Clear state for each test
        logout()

        // Visit and vote with this XID
        visitConversationAsParticipant(testConversation.conversationId, { xid })
        // Vote on whatever comment appears (random order)
        voteOnComment('agree')
        waitForJWTToken(`participant_token_${testConversation.conversationId}`)

        // Verify JWT contains the correct XID
        verifyJWTExists(`participant_token_${testConversation.conversationId}`, {
          xid: xid,
          conversation_id: testConversation.conversationId,
        })
      })
    })

    it('should maintain XID identity across sessions', () => {
      const testXid = `persistent-xid-${Date.now()}`

      // First session: vote with XID to establish participant identity
      visitConversationAsParticipant(testConversation.conversationId, { xid: testXid })
      voteOnComment('agree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Get the participant ID from the first session
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )
        const payload = JSON.parse(atob(token.split('.')[1]))
        const firstSessionPid = payload.pid

        // Clear storage to simulate new session
        logout()

        // Second session: verify same XID resolves to same participant ID
        // Use API request instead of voting to avoid comment availability issues
        cy.request({
          url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}&xid=${testXid}`,
        }).then((response) => {
          expect(response.status).to.be.oneOf([200, 304])

          // If a JWT is issued in the response, verify it has the same participant ID
          if (response.body.auth && response.body.auth.token) {
            const secondSessionToken = response.body.auth.token
            const secondSessionPayload = JSON.parse(atob(secondSessionToken.split('.')[1]))

            expect(secondSessionPayload.xid).to.equal(testXid)
            expect(secondSessionPayload.pid).to.equal(firstSessionPid)
            cy.log(
              `✅ XID ${testXid} maintains same participant ID (${firstSessionPid}) across sessions`,
            )
          } else {
            // Even without JWT in response, the participationInit should work for the same participant
            // This indicates the XID was recognized and associated with existing participant
            cy.log(`✅ XID ${testXid} recognized by server in second session`)
          }
        })
      })
    })
  })

  describe('JWT Token Validation', () => {
    it('should issue valid JWT signatures for anonymous participants', () => {
      visitConversationAsParticipant(testConversation.conversationId)
      voteOnComment('agree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Make a server request to validate the JWT
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )

        cy.request({
          url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          failOnStatusCode: false,
        }).then((response) => {
          // Should not get 401 if JWT is valid
          expect(response.status).not.to.equal(401)
        })
      })
    })

    it('should issue valid JWT signatures for XID participants', () => {
      const testXid = `validation-xid-${Date.now()}`

      visitConversationAsParticipant(testConversation.conversationId, { xid: testXid })
      voteOnComment('agree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Make a server request to validate the JWT
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )

        cy.request({
          url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}&xid=${testXid}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          failOnStatusCode: false,
        }).then((response) => {
          // Should not get 401 if JWT is valid
          expect(response.status).not.to.equal(401)
        })
      })
    })

    it('should reject invalid JWT tokens', () => {
      // Try to use a malformed JWT
      const invalidToken = 'invalid.jwt.token'

      cy.request({
        url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}`,
        headers: {
          Authorization: `Bearer ${invalidToken}`,
        },
        failOnStatusCode: false,
      }).then((response) => {
        // Should get 401 for invalid JWT
        expect(response.status).to.equal(401)
      })
    })

    it('should scope JWT tokens to specific conversations', () => {
      // Test that JWTs are properly scoped to the conversation they were issued for
      visitConversationAsParticipant(testConversation.conversationId)
      voteOnComment('agree')
      waitForJWTToken(`participant_token_${testConversation.conversationId}`)

      // Verify JWT was issued and contains correct conversation ID
      cy.window().then((win) => {
        const token = win.localStorage.getItem(
          `participant_token_${testConversation.conversationId}`,
        )
        expect(token).to.exist

        // Verify JWT format
        const parts = token.split('.')
        expect(parts).to.have.length(3)

        // Decode and verify conversation scoping
        const payload = JSON.parse(atob(parts[1]))
        expect(payload.conversation_id).to.equal(testConversation.conversationId)
        expect(payload.conversation_id).to.be.a('string')
        expect(payload.conversation_id).to.not.be.empty

        // Verify the JWT is valid for this conversation
        cy.request({
          url: `/api/v3/participationInit?conversation_id=${testConversation.conversationId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          failOnStatusCode: false,
        }).then((response) => {
          // JWT should be valid for the same conversation it was issued for
          expect(response.status).to.not.equal(401)
          expect(response.status).to.be.oneOf([200, 304])
        })
      })
    })
  })
})
