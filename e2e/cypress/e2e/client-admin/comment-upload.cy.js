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

          // Upload the CSV file
          cy.fixture('test-comments.csv').then((csvContent) => {
            // Create a File object from the CSV content
            const blob = new Blob([csvContent], { type: 'text/csv' })
            const file = new File([blob], 'test-comments.csv', { type: 'text/csv' })

            // Use cy.get() to find the file input and attach the file
            cy.get('input[type="file"]')
              .should('have.attr', 'accept', '.csv')
              .then(($input) => {
                // Create a DataTransfer object and add the file
                const dataTransfer = new DataTransfer()
                dataTransfer.items.add(file)

                // Set the files property of the input element
                $input[0].files = dataTransfer.files

                // Trigger the change event to simulate file selection
                $input[0].dispatchEvent(new Event('change', { bubbles: true }))
              })

            // Wait a moment for the file to be processed
            cy.wait(500)

            // Click the submit button for bulk upload using data-testid
            cy.get('[data-testid="upload-csv-button"]').click()
          })

          // Wait for the API call to complete
          cy.wait('@bulkComments').then((interception) => {
            expect(interception.response.statusCode).to.eq(200)
            cy.log('✅ CSV upload API call successful')
          })

          // Verify success message appears
          cy.get('button').contains('Success!').should('be.visible')

          // Navigate to the accepted comments section to verify comments were added
          cy.visit(`/m/${testConversationId}/comments/accepted`)

          // Wait for comments to load
          cy.get('[data-testid="approved-comments"]').should('be.visible')

          // Verify that the uploaded comments are visible in the approved comments section
          // We should see at least some of the comments from our CSV
          cy.get('[data-testid="pending-comment"]').should('have.length.at.least', 1)
          cy.get('body').should('contain.text', 'bike lanes over additional car lanes')
          cy.get('body').should('contain.text', 'more frequent bus service')
          cy.get('body').should('contain.text', 'Light rail should be extended')
          cy.get('body').should('contain.text', 'parking meters should be free')
          cy.get('body').should('contain.text', 'sidewalk snow removal')
          cy.get('body').should('contain.text', 'Electric vehicle charging stations')
          cy.get('body').should('contain.text', 'congestion pricing downtown')
          cy.get('body').should('contain.text', 'affordable units')
          cy.get('body').should('contain.text', 'Single-family zoning should be eliminated')
          cy.get('body').should('contain.text', 'public housing')
          cy.get('body').should('contain.text', 'Short-term rentals like Airbnb')
          cy.get('body').should('contain.text', 'Property taxes are too high')
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

          // Upload the empty CSV file
          const blob = new Blob([emptyCsv], { type: 'text/csv' })
          const file = new File([blob], 'empty-comments.csv', { type: 'text/csv' })

          cy.get('input[type="file"]').then(($input) => {
            const dataTransfer = new DataTransfer()
            dataTransfer.items.add(file)
            $input[0].files = dataTransfer.files
            $input[0].dispatchEvent(new Event('change', { bubbles: true }))
          })

          // Wait a moment for the file to be processed
          cy.wait(500)

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
          cy.get('textarea[data-testid="seed_form"]').clear()
          cy.get('textarea[data-testid="seed_form"]').type(manualComment)

          cy.get('button').contains('Submit').first().click()

          cy.wait('@manualComment').then((interception) => {
            expect(interception.response.statusCode).to.eq(200)
            cy.log('✅ Manual comment added successfully')
          })

          // Verify success message
          cy.get('button').contains('Success!').should('be.visible')

          // Now upload CSV comments
          cy.fixture('test-comments.csv').then((csvContent) => {
            const blob = new Blob([csvContent], { type: 'text/csv' })
            const file = new File([blob], 'test-comments.csv', { type: 'text/csv' })

            cy.intercept('POST', '/api/v3/comments-bulk').as('bulkComments')

            cy.get('input[type="file"]').then(($input) => {
              const dataTransfer = new DataTransfer()
              dataTransfer.items.add(file)
              $input[0].files = dataTransfer.files
              $input[0].dispatchEvent(new Event('change', { bubbles: true }))
            })

            // Click the submit button for CSV upload using data-testid
            cy.get('[data-testid="upload-csv-button"]').click()

            cy.wait('@bulkComments').then((interception) => {
              expect(interception.response.statusCode).to.eq(200)
              cy.log('✅ CSV comments added successfully')
            })
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
