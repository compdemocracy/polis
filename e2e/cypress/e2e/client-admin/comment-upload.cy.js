import { loginStandardUser, loginStandardUserAPI, logout } from '../../support/auth-helpers.js'

import { createTestConversationAPI } from '../../support/conversation-helpers.js'

describe('Client Admin: Comment CSV Upload', () => {
  let testConversationId

  beforeEach(() => {
    // Clear any existing auth state
    logout()

    // Login as admin user for all tests
    loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
  })

  describe('CSV Upload Functionality', () => {
    it('should upload comments from CSV file successfully', () => {
      // Create a test conversation first
      loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
        .then(() => {
          return createTestConversationAPI({
            topic: 'CSV Upload Test Conversation',
            description: 'Testing CSV comment upload functionality',
            visualizationEnabled: false,
          })
        })
        .then((convId) => {
          testConversationId = convId
          cy.log(`✅ Created test conversation: ${testConversationId}`)

          // Navigate to the conversation configuration page
          cy.visit(`/m/${testConversationId}`)

          // Wait for the page to load and verify we're on the configure page
          cy.get('h3').should('contain.text', 'Configure')

          // Scroll down to find the CSV upload section
          cy.get('h6').contains('Upload a CSV of seed comments').should('be.visible')

          // Set up intercept for the bulk comments API call
          cy.intercept('POST', '/api/v3/comments-bulk').as('bulkComments')

          // Upload the CSV file using Cypress's built-in selectFile method
          // This is more reliable across different environments, especially CI
          cy.get('input[type="file"]')
            .should('have.attr', 'accept', '.csv')
            .selectFile('cypress/fixtures/test-comments.csv', { force: true })

          // Wait a moment for the file to be processed
          cy.wait(1000)

          // Click the submit button for bulk upload using data-testid
          cy.get('[data-testid="upload-csv-button"]').click()

          // Wait for the API call to complete
          cy.wait('@bulkComments').then((interception) => {
            expect(interception.response.statusCode).to.eq(200)
            cy.log('✅ CSV upload API call successful')
          })

          // Verify success message appears
          cy.get('button').contains('Success!').should('be.visible')

          // Navigate to the accepted comments section to verify comments were added
          cy.visit(`/m/${testConversationId}/comments/pending`)

          cy.wait(1000)

          cy.visit(`/m/${testConversationId}/comments/accepted`)

          cy.wait(1000)

          // Wait for comments to load
          cy.get('[data-testid="approved-comments"]').should('be.visible')

          // Verify that the uploaded comments are visible in the approved comments section
          // We should see at least some of the comments from our CSV
          cy.get('[data-testid="pending-comment"]').should('have.length.at.least', 1)
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'bike lanes over additional car lanes',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'more frequent bus service',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'Light rail should be extended',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'parking meters should be free',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'sidewalk snow removal',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'Electric vehicle charging stations',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'congestion pricing downtown',
          )
          cy.get('[data-testid="approved-comments"]').should('contain.text', 'affordable units')
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'Single-family zoning should be eliminated',
          )
          cy.get('[data-testid="approved-comments"]').should('contain.text', 'public housing')
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'Short-term rentals like Airbnb',
          )
          cy.get('[data-testid="approved-comments"]').should(
            'contain.text',
            'Property taxes are too high',
          )
        })
    })

    it('should handle empty CSV file gracefully', () => {
      // Create a test conversation
      loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
        .then(() => {
          return createTestConversationAPI({
            topic: 'Empty CSV Test Conversation',
            description: 'Testing empty CSV upload handling',
            visualizationEnabled: false,
          })
        })
        .then((convId) => {
          testConversationId = convId
          cy.log(`✅ Created test conversation: ${testConversationId}`)

          // Navigate to the conversation configuration page
          cy.visit(`/m/${testConversationId}`)

          // Wait for the page to load
          cy.get('h3').should('contain.text', 'Configure')

          // Create an empty CSV file
          const emptyCsv = 'comment_text\n'

          // Set up intercept for the bulk comments API call
          cy.intercept('POST', '/api/v3/comments-bulk').as('bulkComments')

          // Upload the empty CSV file using selectFile with contents option
          cy.get('input[type="file"]')
            .should('have.attr', 'accept', '.csv')
            .selectFile(
              {
                contents: Cypress.Buffer.from(emptyCsv),
                fileName: 'empty-comments.csv',
                mimeType: 'text/csv',
              },
              { force: true },
            )

          // Wait a moment for the file to be processed
          cy.wait(1000)

          // Click the submit button for CSV upload using data-testid
          cy.get('[data-testid="upload-csv-button"]').click()

          // Wait for the API call to complete
          cy.wait('@bulkComments').then((interception) => {
            // Should either succeed (with no comments) or return an appropriate error
            expect(interception.response.statusCode).to.be.oneOf([200, 400])
            cy.log('✅ Empty CSV upload handled appropriately')
          })
        })
    })

    it('should allow manual comment entry alongside CSV upload', () => {
      // Create a test conversation
      loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
        .then(() => {
          return createTestConversationAPI({
            topic: 'Manual + CSV Comments Test Conversation',
            description: 'Testing manual comment entry with CSV upload',
            visualizationEnabled: false,
          })
        })
        .then((convId) => {
          testConversationId = convId
          cy.log(`✅ Created test conversation: ${testConversationId}`)

          // Navigate to the conversation configuration page
          cy.visit(`/m/${testConversationId}`)

          // Wait for the page to load
          cy.get('h3').should('contain.text', 'Configure')

          // First, add a manual comment
          const manualComment = 'This is a manually entered test comment'

          cy.intercept('POST', '/api/v3/comments').as('manualComment')

          cy.get('textarea[data-testid="seed_form"]').should('be.visible')
          cy.get('textarea[data-testid="seed_form"]').should('not.be.disabled')
          cy.get('textarea[data-testid="seed_form"]').clear()
          cy.get('textarea[data-testid="seed_form"]').type(manualComment)

          cy.contains('button, input[type="submit"]', /^Submit$/)
            .should('be.visible')
            .click()

          cy.wait('@manualComment').then((interception) => {
            if (interception.response.statusCode !== 200) {
              cy.log('❌ Manual comment failed with status:', interception.response.statusCode)
              cy.log('Response body:', JSON.stringify(interception.response.body))
            }
            expect(interception.response.statusCode).to.eq(200)
            cy.log('✅ Manual comment added successfully')
          })

          // Verify success message
          cy.get('button').contains('Success!').should('be.visible')

          // Now upload CSV comments
          cy.intercept('POST', '/api/v3/comments-bulk').as('bulkComments')

          // Upload CSV file using Cypress's built-in selectFile method
          cy.get('input[type="file"]')
            .should('have.attr', 'accept', '.csv')
            .selectFile('cypress/fixtures/test-comments.csv', { force: true })

          // Wait a moment for the file to be processed
          cy.wait(500)

          // Click the submit button for CSV upload using data-testid
          cy.get('[data-testid="upload-csv-button"]').click()

          cy.wait('@bulkComments').then((interception) => {
            expect(interception.response.statusCode).to.eq(200)
            cy.log('✅ CSV comments added successfully')
          })

          // Verify both manual and CSV comments are present
          cy.visit(`/m/${testConversationId}/comments/accepted`)

          // Wait for comments to load
          cy.get('[data-testid="approved-comments"]').should('be.visible')

          // Verify manual comment is present
          cy.get('body').should('contain.text', manualComment)

          // Verify some CSV comments are present
          cy.get('body').should('contain.text', 'bike lanes over additional car lanes')
          cy.get('body').should('contain.text', 'more frequent bus service')
        })
    })
  })
})
