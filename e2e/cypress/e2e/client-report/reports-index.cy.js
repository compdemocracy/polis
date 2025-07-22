import {
  createTestConversationAPI,
  addCommentsToConversationNoAuth,
} from '../../support/conversation-helpers.js'

describe('Reports - Admin Interface', () => {
  let conversationId

  before(() => {
    cy.log('🚀 Starting Reports test suite setup')

    // Phase 1: Admin setup (isolated window context)
    cy.window().then(() => {
      // Use API-only approach for faster, more reliable setup
      cy.loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*').then(() => {
        cy.log('✅ Admin authenticated via API')

        // Create conversation using helper
        return createTestConversationAPI({
          topic: `Reports Admin Test ${Date.now()}`,
          description: 'Test conversation for reports admin interface tests',
        })
          .then((convId) => {
            conversationId = convId
            cy.log(`✅ Created test conversation via API: ${conversationId}`)

            // Add comment using no-auth helper (more efficient)
            return addCommentsToConversationNoAuth(conversationId, [
              'Test comment for report generation',
            ])
          })
          .then(() => {
            cy.log('✅ Added test comment via API')
          })
      })
    })

    // Clean logout after setup
    cy.logout()
  })

  beforeEach(() => {
    cy.log(`🔄 Setting up test - conversationId: ${conversationId}`)

    // Login as admin and navigate to reports section
    cy.loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

    // Visit the reports URL directly instead of using the helper
    cy.visit(`/m/${conversationId}/reports`)

    // Wait for page to load - check for a specific element instead of arbitrary wait
    cy.get('h1, h2, h3, h4').should('be.visible')
  })

  describe('Reports List', () => {
    it('should display the reports section', () => {
      // First use .then() for logging
      cy.get('h1, h2, h3, h4').then(($headings) => {
        const headingTexts = $headings.toArray().map((el) => el.textContent)
        cy.log(`Found headings: ${headingTexts.join(', ')}`)
      })

      // Then use .should() for assertion only
      cy.get('h1, h2, h3, h4').should(($headings) => {
        const headingTexts = $headings.toArray().map((el) => el.textContent)

        // Check if any heading contains "Report"
        const hasReportHeading = headingTexts.some(
          (text) => text && text.toLowerCase().includes('report'),
        )

        expect(hasReportHeading, 'Should find a heading containing "Report"').to.be.true
      })

      // Verify the create button exists
      cy.get('button').contains('Create report url').should('be.visible')
    })

    it('should create a new report', () => {
      // Intercept the API call
      cy.intercept('POST', '/api/v3/reports').as('createReport')
      cy.intercept('GET', '/api/v3/reports*').as('getReports')

      // Click create report button
      cy.get('button').contains('Create report url').click()

      // Wait for the API calls
      cy.wait('@createReport').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      cy.wait('@getReports').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Verify a report URL appears
      cy.get('a[href*="/report/"]', { timeout: 10000 }).should('exist')
      cy.get('[data-testid="report-list-item"]').should('have.length.at.least', 1)
    })

    it('should display multiple reports after creating several', () => {
      // Set up intercepts
      cy.intercept('POST', '/api/v3/reports').as('createReport')
      cy.intercept('GET', '/api/v3/reports*').as('getReports')

      // Create multiple reports
      cy.get('button').contains('Create report url').click()
      cy.wait('@createReport')
      cy.wait('@getReports')

      cy.get('button').contains('Create report url').click()
      cy.wait('@createReport')
      cy.wait('@getReports')

      // Verify multiple report URLs are shown
      cy.get('[data-testid="report-list-item"]').should('have.length.at.least', 2)
    })

    it('should have clickable report URLs that open in new tab', () => {
      // Set up intercepts
      cy.intercept('POST', '/api/v3/reports').as('createReport')
      cy.intercept('GET', '/api/v3/reports*').as('getReports')

      // Create a report if none exist
      cy.get('body').then(($body) => {
        if ($body.find('[data-testid="report-list-item"]').length === 0) {
          cy.get('button').contains('Create report url').click()
          cy.wait('@createReport')
          cy.wait('@getReports')
        }
      })

      // Verify report link has correct attributes
      cy.get('[data-testid="report-list-item"] a')
        .first()
        .should('have.attr', 'target', '_blank')
        .and('have.attr', 'rel', 'noreferrer')
        .and('have.attr', 'href')
        .and('contain', '/report/')

      // Verify the report URL format
      cy.get('[data-testid="report-list-item"] a')
        .first()
        .then(($link) => {
          const href = $link.attr('href')

          // Verify URL format matches /report/[report_id]
          expect(href).to.match(/\/report\/r?[0-9a-zA-Z]+$/)

          // Extract report ID
          const reportId = href.split('/report/')[1]
          expect(reportId).to.have.length.at.least(1)
        })
    })
  })

  describe('Report Creation API', () => {
    it('should handle API errors gracefully', () => {
      // Intercept API call to simulate error
      cy.intercept('POST', '/api/v3/reports', {
        statusCode: 500,
        body: { error: 'Server error' },
      }).as('createReportError')

      // Try to create report
      cy.get('button').contains('Create report url').click()

      // Wait for error response
      cy.wait('@createReportError')

      // The component should handle the error (though it doesn't show error UI currently)
      // At minimum, the page shouldn't crash
      cy.get('body').should('contain', 'Report')
    })

    it('should refresh report list after successful creation', () => {
      // Intercept the GET reports call
      cy.intercept('GET', '/api/v3/reports*').as('getReports')

      // Create a new report
      cy.get('button').contains('Create report url').click()

      // Verify that reports list is refreshed
      cy.wait('@getReports')

      // New report should appear in the list
      cy.get('[data-testid="report-list-item"]').should('exist')
    })
  })
})
