import {
  createTestConversationAPI,
  addCommentsToConversation,
} from '../../support/conversation-helpers.js'
import { getAuthToken } from '../../support/auth-helpers.js'

describe('Reports - Functionality & Features', () => {
  let conversationId
  let reportId
  let reportUrl

  before(() => {
    cy.log('🚀 Starting Reports Functionality test suite setup')

    // Phase 1: Admin setup (isolated window context)
    cy.window().then(() => {
      // Use API-only approach to avoid UI authentication complexity
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        cy.log('✅ Admin authenticated via API')

        // Create conversation using helper
        return createTestConversationAPI({
          topic: `Report Functionality Test ${Date.now()}`,
          description: 'Test conversation for report functionality tests',
        })
          .then((convId) => {
            conversationId = convId
            cy.log(`✅ Created test conversation: ${conversationId}`)

            // Add comments using helper
            return addCommentsToConversation(
              conversationId,
              [
                'We should increase funding for public education',
                'Tax cuts will stimulate economic growth',
                'Environmental protection is our top priority',
                'We need better healthcare access for all',
                'Small businesses need more support',
              ],
              'admin@polis.test',
              'Te$tP@ssw0rd*',
            )
          })
          .then(() => {
            // Create report via API
            return getAuthToken().then((token) => {
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
                      cy.wait(1000) // wait for the report to be created
                      cy.log(`✅ Created report: ${reportId} with URL: ${reportUrl}`)
                    })
                })
            })
          })
      })
    })
  })

  describe('Report Content Viewing', () => {
    it('should display basic report structure', () => {
      // Intercept the report data API call
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Check for common report elements using direct assertions
      cy.contains('Report', { timeout: 10000 }).should('be.visible')
      cy.contains('Overview', { timeout: 10000 }).should('be.visible')

      // Should show basic information about the report
      cy.contains('people voted').should('be.visible')
      cy.contains('people grouped').should('be.visible')
      cy.contains('votes were cast').should('be.visible')
      cy.contains('statements were submitted').should('be.visible')
      cy.contains('votes per voter').should('be.visible')
      cy.contains('statements per author').should('be.visible')
    })

    it('should show conversation overview section', () => {
      // Intercept the report data API call
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Look for overview content
      cy.get('body').should('contain.text', 'Overview')

      // Should show the admin who ran the conversation
      cy.contains('This pol.is conversation was run by Test Admin.').should('be.visible')
    })

    it('should display data export links', () => {
      // Intercept the report data API call
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Should have raw data export section
      cy.contains('Raw Data Export').should('exist')

      // Should have CSV download links
      cy.get('a[href*=".csv"]').should('have.length.at.least', 1)
    })

    it('should handle empty/minimal data gracefully', () => {
      // Create a new conversation with no data using API
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        return getAuthToken().then((token) => {
          return cy
            .request({
              method: 'POST',
              url: '/api/v3/conversations',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: {
                topic: `Empty Report Test ${Date.now()}`,
                description: 'Empty conversation for testing minimal data',
                is_anon: true,
                is_active: true,
                vis_type: 0,
              },
            })
            .then((response) => {
              expect(response.status).to.eq(200)
              const emptyConvId = response.body.conversation_id

              // Create report via API
              return cy
                .request({
                  method: 'POST',
                  url: '/api/v3/reports',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                  },
                  body: {
                    conversation_id: emptyConvId,
                  },
                })
                .then((response) => {
                  expect(response.status).to.eq(200)

                  // Get the created report
                  return cy
                    .request({
                      method: 'GET',
                      url: `/api/v3/reports?conversation_id=${emptyConvId}`,
                      headers: {
                        Authorization: `Bearer ${token}`,
                      },
                    })
                    .then((getResponse) => {
                      expect(getResponse.status).to.eq(200)
                      expect(getResponse.body).to.be.an('array')
                      expect(getResponse.body.length).to.be.greaterThan(0)

                      const emptyReportId = getResponse.body[0].report_id
                      const emptyReportUrl = `/report/${emptyReportId}`

                      // Now test the empty report as anonymous user
                      cy.logout()

                      // Intercept the report data API calls
                      cy.intercept('GET', '/api/v3/reports*').as('getReport')

                      cy.visit(emptyReportUrl)

                      // Wait for the report to load (may return empty data)
                      cy.wait('@getReport')

                      // Should still load without errors
                      cy.get('body').should('exist')

                      // Empty reports show "Nothing to show yet"
                      cy.contains('Nothing to show yet', { timeout: 10000 }).should('be.visible')
                    })
                })
            })
        })
      })
    })
  })

  describe('Report Metadata Updates', () => {
    beforeEach(() => {
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should update report name', () => {
      const newReportName = 'Q4 2024 Community Feedback Report'

      getAuthToken().then((token) => {
        cy.request({
          method: 'PUT',
          url: '/api/v3/reports',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: {
            conversation_id: conversationId,
            report_id: reportId,
            report_name: newReportName,
          },
        }).then((response) => {
          expect(response.status).to.eq(200)
        })

        // Verify update by fetching report
        cy.request({
          method: 'GET',
          url: `/api/v3/reports?report_id=${reportId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).then((response) => {
          expect(response.body[0]).to.have.property('report_name', newReportName)
        })
      })
    })

    it('should update axis labels', () => {
      const labels = {
        label_x_pos: 'Progressive',
        label_x_neg: 'Conservative',
        label_y_pos: 'Interventionist',
        label_y_neg: 'Libertarian',
      }

      getAuthToken().then((token) => {
        cy.request({
          method: 'PUT',
          url: '/api/v3/reports',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: {
            conversation_id: conversationId,
            report_id: reportId,
            ...labels,
          },
        }).then((response) => {
          expect(response.status).to.eq(200)
        })

        // Verify labels were saved
        cy.request({
          method: 'GET',
          url: `/api/v3/reports?report_id=${reportId}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).then((response) => {
          const report = response.body[0]
          Object.entries(labels).forEach(([key, value]) => {
            expect(report).to.have.property(key, value)
          })
        })
      })
    })

    it('should update group labels', () => {
      const groupLabels = {
        label_group_0: 'Fiscal Conservatives',
        label_group_1: 'Social Progressives',
        label_group_2: 'Moderates',
        label_group_3: 'Libertarians',
      }

      getAuthToken().then((token) => {
        cy.request({
          method: 'PUT',
          url: '/api/v3/reports',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: {
            conversation_id: conversationId,
            report_id: reportId,
            ...groupLabels,
          },
        }).then((response) => {
          expect(response.status).to.eq(200)
        })
      })
    })
  })

  describe('Report Type Navigation', () => {
    it('should load Standard Report variant', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const variantUrl = '/report/' + reportId
      cy.visit(variantUrl, { failOnStatusCode: false })

      // Wait for the report to load
      cy.wait('@getReport')

      // Should load without error
      cy.get('body').should('exist')

      // URL should remain on the report type
      cy.url().should('include', '/report/')
    })

    it('should load Narrative Report variant', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const variantUrl = '/narrativeReport/' + reportId
      cy.visit(variantUrl, { failOnStatusCode: false })

      // Wait for the report to load
      cy.wait('@getReport')

      // Should load without error
      cy.get('body').should('exist')

      // URL should remain on the report type
      cy.url().should('include', '/narrativeReport/')
    })

    it('should load Statistics variant', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const variantUrl = '/stats/' + reportId
      cy.visit(variantUrl, { failOnStatusCode: false })

      // Wait for the report to load
      cy.wait('@getReport')

      // Should load without error
      cy.get('body').should('exist')

      // URL should remain on the report type
      cy.url().should('include', '/stats/')
    })

    it('should load Comments Report variant', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const variantUrl = '/commentsReport/' + reportId
      cy.visit(variantUrl, { failOnStatusCode: false })

      // Wait for the report to load
      cy.wait('@getReport')

      // Should load without error
      cy.get('body').should('exist')

      // URL should remain on the report type
      cy.url().should('include', '/commentsReport/')
    })

    it('should load Topics Report variant', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const variantUrl = '/topicReport/' + reportId
      cy.visit(variantUrl, { failOnStatusCode: false })

      // Wait for the report to load
      cy.wait('@getReport')

      // Should load without error
      cy.get('body').should('exist')

      // URL should remain on the report type
      cy.url().should('include', '/topicReport/')
    })
  })

  describe('Report Export Functionality', () => {
    it('should provide working CSV export links', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Find CSV export links
      cy.get('a').each(($link) => {
        const href = $link.attr('href')
        if (href && href.includes('.csv')) {
          // Verify link format
          expect(href).to.match(/\/api\/v3\/.*\.csv/)

          // Links should have download attribute or open in new tab
          const hasDownload = $link.attr('download') !== undefined
          const opensInNewTab = $link.attr('target') === '_blank'
          expect(hasDownload || opensInNewTab).to.be.true
        }
      })
    })

    it('should show correct export endpoints', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Expected export types
      const expectedExports = [
        'summary.csv',
        'comments.csv',
        'votes.csv',
        'participant-votes.csv',
        'comment-groups.csv',
      ]

      // Check that export links exist
      expectedExports.forEach((exportType) => {
        cy.get('a[href*="' + exportType + '"]').should('exist')
      })
    })
  })

  describe('Report Responsiveness', () => {
    // Skipping mobile for now as it's not fully supported
    it('should be responsive on tablet', () => {
      cy.viewport(768, 1024)

      // Intercept report data API calls to ensure content loads
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Wait for key report content to load
      cy.contains('Report', { timeout: 10000 }).should('be.visible')
      cy.contains('Overview', { timeout: 10000 }).should('be.visible')

      // Wait for export section which indicates full content load
      cy.contains('Raw Data Export', { timeout: 10000 }).should('be.visible')

      // Content should be visible
      cy.get('body').should('be.visible')
    })

    it('should be responsive on desktop', () => {
      cy.viewport(1920, 1080)

      // Intercept report data API calls to ensure content loads
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Wait for key report content to load
      cy.contains('Report', { timeout: 10000 }).should('be.visible')
      cy.contains('Overview', { timeout: 10000 }).should('be.visible')

      // Wait for export section which indicates full content load
      cy.contains('Raw Data Export', { timeout: 10000 }).should('be.visible')

      // Content should be visible
      cy.get('body').should('be.visible')
    })
  })

  describe('Report Performance', () => {
    it('should load report within reasonable time', () => {
      // Intercept the report data API calls
      cy.intercept('GET', '/api/v3/reports*').as('getReport')

      const startTime = Date.now()

      cy.visit(reportUrl)

      // Wait for the report to load
      cy.wait('@getReport')

      // Wait for main content to appear
      cy.contains('Report').should('exist')
      cy.contains('Overview')
        .should('exist')
        .then(() => {
          const loadTime = Date.now() - startTime
          // Report should load within 1 second
          expect(loadTime).to.be.lessThan(1000)
        })
    })
  })
})
