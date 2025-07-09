import {
  createTestConversationAPI,
  addCommentsToConversation,
} from '../../support/conversation-helpers.js'

describe('Reports - Authentication & Access Control', () => {
  let conversationId
  let reportId
  let reportUrl

  before(() => {
    cy.log('🚀 Starting Reports Authentication test suite setup')

    // Phase 1: Admin setup (isolated window context)
    cy.window().then(() => {
      // Use API-only approach to avoid UI authentication complexity
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        cy.log('✅ Admin authenticated via API')

        // Create conversation using helper
        return createTestConversationAPI({
          topic: `Report Auth Test ${Date.now()}`,
          description: 'Test conversation for report authentication tests',
        })
          .then((convId) => {
            conversationId = convId
            cy.log(`✅ Created test conversation: ${conversationId}`)

            // Add comments using helper (will re-authenticate, but that's OK)
            return addCommentsToConversation(
              conversationId,
              ['First test comment for reports', 'Second test comment for reports'],
              'admin@polis.test',
              'Te$tP@ssw0rd*',
            )
          })
          .then(() => {
            // Create report via API
            return cy.window().then((win) => {
              const token = win.localStorage.getItem('auth_token')
              expect(token).to.exist

              return cy
                .request({
                  method: 'POST',
                  url: '/api/v3/reports',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                  },
                  body: {
                    conversation_id: conversationId,
                  },
                })
                .then((response) => {
                  expect(response.status).to.eq(200)

                  // Get the created report
                  return cy
                    .request({
                      method: 'GET',
                      url: `/api/v3/reports?conversation_id=${conversationId}`,
                      headers: {
                        Authorization: `Bearer ${token}`,
                      },
                    })
                    .then((getResponse) => {
                      expect(getResponse.status).to.eq(200)
                      expect(getResponse.body).to.be.an('array')
                      expect(getResponse.body.length).to.be.greaterThan(0)

                      reportId = getResponse.body[0].report_id
                      reportUrl = `/report/${reportId}`
                      cy.log(`✅ Created report: ${reportId} with URL: ${reportUrl}`)
                    })
                })
            })
          })
      })
    })

    // Clean logout after setup
    cy.logout()
  })

  describe('Report Creation Permissions', () => {
    it('should allow conversation owner to create reports', () => {
      cy.loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      // Wait for login to complete
      cy.url().should('not.include', '/signin')
      cy.wait(1000)

      cy.visit(`/m/${conversationId}/reports`)
      cy.wait(1000)

      // Should see create button
      cy.get('button').contains('Create report url').should('be.visible')
    })

    it('should prevent unauthorized users from accessing report creation', () => {
      // Try to access admin interface without logging in
      cy.visit(`/m/${conversationId}`)

      // Should redirect to login
      cy.url().should('include', '/signin')

      // Should not be able to access reports section directly
      cy.visit(`/m/${conversationId}/report`)
      cy.url().should('include', '/signin')
    })

    it('should show "No Permission" for logged in non-owner', () => {
      cy.loginStandardUser('moderator@polis.test', 'Te$tP@ssw0rd*')

      // Wait for login to complete
      cy.url().should('not.include', '/signin')
      cy.wait(1000)

      // Try to access the conversation admin page (reports section)
      cy.visit(`/m/${conversationId}/reports`, { failOnStatusCode: false })

      // Wait for the page to load - first check that we're not on a redirect/login page
      cy.url().should('include', `/m/${conversationId}`)

      // Wait for the Auth0 authentication and page loading to complete
      // The page will show "Loading Reports..." first, then either the reports or no permission
      cy.get('body').should('be.visible')

      // Wait for loading to complete - either reports load or permission error shows
      cy.get('body').then(($body) => {
        // If we see loading, wait for it to finish
        if ($body.text().includes('Loading Reports...')) {
          cy.contains('Loading Reports...').should('not.exist', { timeout: 10000 })
        }
      })

      // Now check for the no permission message
      // The NoPermission component should render with the specific text
      cy.get('body').then(($body) => {
        const bodyText = $body.text()

        // Check for the specific "No Permission" text from the strings
        const hasNoPermission = bodyText.includes(
          'Your account does not have the permissions to view this page',
        )

        // Or check for the no-permission div ID
        const hasNoPermissionDiv = $body.find('#no-permission-warning').length > 0

        expect(hasNoPermission).to.be.true
        expect(hasNoPermissionDiv).to.be.true
        expect(bodyText).to.not.include('Create report url')
      })

      cy.logout()
    })
  })

  describe('Report Viewing Permissions', () => {
    it('should allow anonymous users to view reports', () => {
      // Ensure we're logged out
      cy.logout()

      // Visit report URL directly
      cy.visit(reportUrl)

      // Wait for the report to load
      cy.url().should('not.include', '/signin')
      cy.get('body').should('be.visible')

      // Wait for any loading states to complete
      cy.get('body').then(($body) => {
        if ($body.text().includes('loading') || $body.text().includes('Loading')) {
          cy.wait(1000) // Give time for report to load
        }
      })

      // Should see report content
      cy.get('body').should('contain', 'Report')

      // Should see some report elements
      cy.get('[data-test-id*="reports-overview"]').should('exist')
      cy.get('body').should('contain', 'Overview')
    })

    it('should allow owner to view reports', () => {
      // Login as a different user
      cy.loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      // Wait for login to complete
      cy.url().should('not.include', '/signin')
      cy.wait(1000)

      // Visit report URL
      cy.visit(reportUrl)

      // Wait for the report to load
      cy.get('body').should('be.visible')

      // Wait for any loading states to complete
      cy.get('body').then(($body) => {
        if ($body.text().includes('loading') || $body.text().includes('Loading')) {
          cy.wait(1000) // Give time for report to load
        }
      })

      // Should see report content
      cy.get('body').should('contain', 'Report')

      // Should see some report elements
      cy.get('[data-test-id*="reports-overview"]').should('exist')
      cy.get('body').should('contain', 'Overview')

      cy.logout()
    })

    it('should allow non-owner to view reports', () => {
      // Login as a different user
      cy.loginStandardUser('moderator@polis.test', 'Te$tP@ssw0rd*')

      // Wait for login to complete
      cy.url().should('not.include', '/signin')
      cy.wait(1000)

      // Visit report URL
      cy.visit(reportUrl)

      // Wait for the report to load
      cy.get('body').should('be.visible')

      // Wait for any loading states to complete
      cy.get('body').then(($body) => {
        if ($body.text().includes('loading') || $body.text().includes('Loading')) {
          cy.wait(1000) // Give time for report to load
        }
      })

      // Should see report content
      cy.get('body').should('contain', 'Report')

      // Should see some report elements
      cy.get('[data-test-id*="reports-overview"]').should('exist')
      cy.get('body').should('contain', 'Overview')

      cy.logout()
    })

    it('should handle invalid report IDs gracefully', () => {
      // Try to access non-existent report
      cy.visit('/report/invalidreportid123', { failOnStatusCode: false })

      // Should show error or empty report
      cy.get('body').then(($body) => {
        // Page should load but might show error or empty state
        expect($body.text()).to.include('Cannot GET')
      })
    })
  })

  describe('Report Types Access', () => {
    const reportTypes = [
      { type: 'report', path: '/report/' },
      { type: 'narrativeReport', path: '/narrativeReport/' },
      { type: 'stats', path: '/stats/' },
      { type: 'commentsReport', path: '/commentsReport/' },
      { type: 'topicReport', path: '/topicReport/' },
      { type: 'topicsVizReport', path: '/topicsVizReport/' },
      { type: 'exportReport', path: '/exportReport/' },
      { type: 'topicMapNarrativeReport', path: '/topicMapNarrativeReport/' },
    ]

    reportTypes.forEach(({ type, path }) => {

      it(`should allow access to ${type} without authentication`, () => {
        // Ensure logged out
        cy.logout()

        // Visit different report type URL
        const typeUrl = path + reportId
        cy.visit(typeUrl, { failOnStatusCode: false })

        // Should not redirect to login
        cy.url().should('include', path)

        // Should load some content (not error page)
        cy.get('body').then(($body) => {
          // Should not show server errors
          expect($body.text()).to.not.include('Cannot GET')
          expect($body.text()).to.not.include('404')
        })
      })
    })
  })

  describe('Report API Access', () => {
    it('should require authentication for report API endpoints', () => {
      // Logout to test anonymous access
      cy.logout()

      // Try to create report without auth
      cy.request({
        method: 'POST',
        url: '/api/v3/reports',
        body: { conversation_id: conversationId },
        failOnStatusCode: false,
      }).then((response) => {
        // Should be unauthorized
        expect(response.status).to.be.oneOf([401, 403])
      })
    })

    it('should allow authenticated users to fetch reports', () => {
      // Login and get auth token
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        // Get auth token from localStorage
        return cy.window().then((win) => {
          const token = win.localStorage.getItem('auth_token')
          expect(token).to.exist

          // Fetch reports for conversation
          return cy
            .request({
              method: 'GET',
              url: `/api/v3/reports?conversation_id=${conversationId}`,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            })
            .then((response) => {
              expect(response.status).to.eq(200)
              expect(response.body).to.be.an('array')
              expect(response.body.length).to.be.greaterThan(0)
            })
        })
      })
    })

    it('should allow fetching specific report by ID', () => {
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        // Get auth token from localStorage
        return cy.window().then((win) => {
          const token = win.localStorage.getItem('auth_token')
          expect(token).to.exist

          // Fetch specific report
          return cy
            .request({
              method: 'GET',
              url: `/api/v3/reports?report_id=${reportId}`,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            })
            .then((response) => {
              expect(response.status).to.eq(200)
              expect(response.body).to.be.an('array')
              expect(response.body[0]).to.have.property('report_id', reportId)
            })
        })
      })
    })
  })

  describe('Cross-Origin Report Access', () => {
    it('should handle CORS for report viewing', () => {
      // Reports should be viewable from different origins
      // This is important for embedding

      // Visit report with different origin header
      cy.visit(reportUrl, {
        onBeforeLoad: (win) => {
          // Simulate cross-origin request
          Object.defineProperty(win.document, 'referrer', {
            get: () => 'https://external-site.com',
          })
        },
      })

      // Should still load successfully
      cy.get('body').should('contain', 'Report')
    })
  })

  describe('Report Data Security', () => {
    it('should not expose sensitive participant data in public reports', () => {
      // Visit report as anonymous user
      cy.logout()
      cy.visit(reportUrl)

      // Check that sensitive data is not exposed
      cy.get('body').then(($body) => {
        const bodyText = $body.text()

        // Should not contain email addresses
        expect(bodyText).to.not.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)

        // Should not contain auth tokens
        expect(bodyText).to.not.include('token')
        expect(bodyText).to.not.include('jwt')

        // Should not contain IP addresses
        expect(bodyText).to.not.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/)
      })
    })
  })
})
