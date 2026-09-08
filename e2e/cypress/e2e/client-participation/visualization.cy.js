/**
 * Visualization tests
 * Verifies that the PCA visualization appears after sufficient participants vote.
 *
 * The client only un-hides #vis_section once a math (PCA) result served by
 * /api/v3/math/pca2 reports at least MIN_PTPTS participants -- see
 * onPersonUpdate() in client-participation/js/views/participation.js, which
 * derives its count from sum(pca['base-clusters'].count), not from the
 * conversation's participant_count. The conversation's participant_count is
 * updated the moment people vote, but the Clojure math service publishes on
 * its own poll cycle and the API server caches/prefetches those results, so
 * "everyone has voted" is NOT the same precondition as "the visualization can
 * be drawn". This spec therefore polls the math endpoint for the real
 * precondition before loading the page under test; otherwise a slow math cycle
 * shows up as a bogus "#vis_section should be visible" timeout.
 */

describe('Visualization', function () {
  let conversationId
  const participationView = '[data-view-name="participationView"]'
  const timeout = { timeout: 30000 }

  // Keep in sync with MIN_PTPTS in client-participation/js/views/participation.js
  const MIN_PTPTS = 7
  // Bounded but generous: the math service polls votes on an interval and the
  // API server prefetches/caches its output, so give it real room under CI load.
  const MATH_POLL_INTERVAL_MS = 2000
  const MATH_POLL_MAX_ATTEMPTS = 60

  // Counts exactly what onPersonUpdate() counts.
  const mathParticipantCount = (body) => {
    const counts = (body && body['base-clusters'] && body['base-clusters'].count) || []
    return counts.reduce((total, n) => total + n, 0)
  }

  const mathGroupCount = (body) => ((body && body['group-clusters']) || []).length

  // Poll the served math blob until it carries the participant and group counts
  // the client needs in order to render the visualization.
  const waitForMathResult = (attempt) => {
    return cy
      .request({
        method: 'GET',
        url: `/api/v3/math/pca2?conversation_id=${conversationId}&cacheBust=${attempt}`,
        failOnStatusCode: false,
      })
      .then((mathResponse) => {
        const participants = mathParticipantCount(mathResponse.body)
        const groups = mathGroupCount(mathResponse.body)

        if (participants >= MIN_PTPTS && groups > 0) {
          cy.log(`📊 Math ready: ${participants} participants in ${groups} groups`)
          return cy.wrap(participants)
        }

        if (attempt >= MATH_POLL_MAX_ATTEMPTS) {
          throw new Error(
            `Math service never published a PCA result with ${MIN_PTPTS}+ participants ` +
              `and at least one group for conversation ${conversationId}. ` +
              `Last seen: ${participants} participants, ${groups} groups after ` +
              `${MATH_POLL_MAX_ATTEMPTS} attempts (~${(MATH_POLL_MAX_ATTEMPTS * MATH_POLL_INTERVAL_MS) / 1000}s).`,
          )
        }

        cy.wait(MATH_POLL_INTERVAL_MS)
        return waitForMathResult(attempt + 1)
      })
  }

  it('creates conversation and shows visualization with 7 participants', function () {
    cy.log('🚀 Setting up visualization test with clean auth')

    // Step 1: Get admin token and create conversation via API
    cy.request({
      method: 'POST',
      url: `${Cypress.env('AUTH_ISSUER')}oauth/token`,
      body: {
        grant_type: 'password',
        username: 'admin@polis.test',
        password: 'Te$tP@ssw0rd*',
        audience: Cypress.env('AUTH_AUDIENCE'),
        client_id: Cypress.env('AUTH_CLIENT_ID'),
        scope: 'openid profile email',
      },
    })
      .then((authResponse) => {
        const adminToken = authResponse.body.access_token

        // Create conversation with visualization enabled
        return cy.request({
          method: 'POST',
          url: '/api/v3/conversations',
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
          body: {
            topic: 'Visualization Test Conversation',
            description: 'Testing PCA visualization with multiple participants',
            is_anon: true,
            is_active: true,
            vis_type: 1, // Enable visualization
          },
        })
      })
      .then((convResponse) => {
        conversationId = convResponse.body.conversation_id
        cy.log(`✅ Created conversation with visualization: ${conversationId}`)

        // Get admin token again for adding comments
        return cy.request({
          method: 'POST',
          url: `${Cypress.env('AUTH_ISSUER')}oauth/token`,
          body: {
            grant_type: 'password',
            username: 'admin@polis.test',
            password: 'Te$tP@ssw0rd*',
            audience: Cypress.env('AUTH_AUDIENCE'),
            client_id: Cypress.env('AUTH_CLIENT_ID'),
            scope: 'openid profile email',
          },
        })
      })
      .then((authResponse) => {
        const adminToken = authResponse.body.access_token

        // Add 3 comments
        const comments = ['Comment 1', 'Comment 2', 'Comment 3']
        const addComments = comments.map((comment) => {
          return cy.request({
            method: 'POST',
            url: '/api/v3/comments',
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
            body: {
              conversation_id: conversationId,
              txt: comment,
              is_seed: true,
            },
          })
        })

        return Promise.all(addComments)
      })
      .then(() => {
        cy.log('✅ Added all comments')

        // Get admin token to enable visualization
        return cy.request({
          method: 'POST',
          url: `${Cypress.env('AUTH_ISSUER')}oauth/token`,
          body: {
            grant_type: 'password',
            username: 'admin@polis.test',
            password: 'Te$tP@ssw0rd*',
            audience: Cypress.env('AUTH_AUDIENCE'),
            client_id: Cypress.env('AUTH_CLIENT_ID'),
            scope: 'openid profile email',
          },
        })
      })
      .then((authResponse) => {
        const adminToken = authResponse.body.access_token

        // First get current conversation data
        return cy
          .request({
            method: 'GET',
            url: `/api/v3/conversations?conversation_id=${conversationId}`,
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
          })
          .then((getResponse) => {
            const conversationData = getResponse.body

            // Update with visualization enabled
            return cy.request({
              method: 'PUT',
              url: '/api/v3/conversations',
              headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json; charset=utf-8',
              },
              body: {
                ...conversationData,
                vis_type: 1, // Enable visualization
              },
            })
          })
      })
      .then(() => {
        cy.log('✅ Enabled visualization')

        // Verify visualization is enabled
        return cy.request({
          method: 'GET',
          url: `/api/v3/conversations?conversation_id=${conversationId}`,
          failOnStatusCode: false,
        })
      })
      .then((response) => {
        const visType = response.body?.vis_type
        const initialCount = response.body?.participant_count || 0
        cy.log(`📊 Visualization status: vis_type = ${visType}`)
        cy.log(`📊 Initial participant count: ${initialCount}`)
        expect(visType).to.equal(1, 'Visualization should be enabled')

        // CRITICAL: Clear ALL state before creating participants
        cy.clearLocalStorage()
        cy.clearAllSessionStorage()

        // Step 2: Create 7 participants
        cy.log('🧪 Creating 7 participants sequentially')

        // Define the participant creation function
        const createParticipant = (index) => {
          const xid = `clean-viz-${Date.now()}-${index}`
          cy.log(`👤 Creating participant ${index}/7 with XID: ${xid}`)

          // Clear everything for each participant
          cy.clearLocalStorage()
          cy.clearAllSessionStorage()

          // Intercept the vote request
          cy.intercept('POST', '/api/v3/votes').as('voteRequest')

          // Visit with XID
          cy.visit(`/${conversationId}?xid=${xid}`)

          // Wait for page to be ready and first vote button to be stable
          cy.get('body').should('be.visible')
          cy.get('#agreeButton', { timeout: 15000 }).should('be.visible').should('not.be.disabled')
          cy.get('#agreeButton').click()
          cy.wait('@voteRequest')

          // Second comment - vary the votes
          const voteButtons = ['#agreeButton', '#disagreeButton', '#passButton']
          const secondButton = voteButtons[index % 3]
          cy.get(secondButton, { timeout: 10000 }).should('be.visible').should('not.be.disabled')
          cy.get(secondButton).click()
          cy.wait('@voteRequest')

          // Third comment
          const thirdButton = voteButtons[(index + 1) % 3]
          cy.get(thirdButton, { timeout: 10000 }).should('be.visible').should('not.be.disabled')
          cy.get(thirdButton).click()
          cy.wait('@voteRequest')

          // Wait for completion message and ensure it's stable
          cy.contains("You've voted on all", { timeout: 10000 }).should('be.visible')
          cy.log(`✅ Participant ${index} completed voting successfully`)

          // Return a Cypress chainable
          return cy.wrap(index)
        }

        // Create all 7 participants sequentially using cy.then() chains
        cy.log('🧪 Creating 7 participants sequentially')

        // Start with participant 1 and chain through all 7
        createParticipant(1)
          .then(() => {
            return createParticipant(2)
          })
          .then(() => {
            return createParticipant(3)
          })
          .then(() => {
            return createParticipant(4)
          })
          .then(() => {
            return createParticipant(5)
          })
          .then(() => {
            return createParticipant(6)
          })
          .then(() => {
            return createParticipant(7)
          })
          .then(() => {
            cy.log('🎉 All participant creation completed')
          })

        // Step 3: Verify and trigger visualization
        cy.log('📊 Verifying participant count and triggering math')

        // Check participant count
        cy.request({
          method: 'GET',
          url: `/api/v3/conversations?conversation_id=${conversationId}`,
          failOnStatusCode: false,
        }).then((response) => {
          const count = response.body?.participant_count || 0
          cy.log(`📊 Final participant count: ${count}`)
          expect(count).to.be.at.least(7, 'Should have at least 7 participants')
        })

        // Step 3b: Wait for the actual precondition the client gates on -- a
        // published math result carrying MIN_PTPTS participants and >=1 group.
        // Without this the assertions below race the math service's poll cycle.
        cy.log('⏳ Waiting for math to publish a result the visualization can use')
        waitForMathResult(1)

        // Step 4: Check visualization
        cy.log('🔍 Checking visualization')

        // Clear state and visit as new participant
        cy.clearLocalStorage()

        // Set up intercepts
        cy.intercept('GET', '/api/v3/math/pca2*').as('getMath')
        cy.intercept('GET', '/api/v3/votes/famous*').as('getFamous')
        cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')

        cy.visit(`/${conversationId}`)

        // Wait for data
        cy.wait('@participationInit')
        cy.wait('@getMath', timeout)
        cy.wait('@getFamous', timeout)

        // Check for visualization elements
        cy.get(participationView, timeout).should('exist')
        cy.get('#vis_section', timeout).should('exist').and('be.visible')
        cy.get('#vis_help_label', timeout).should('exist').and('be.visible')
        cy.get('#vis_not_yet_label', timeout).should('not.be.visible')

        cy.log('✅ Visualization correctly shown with 7+ participants!')
      })
  })
})
