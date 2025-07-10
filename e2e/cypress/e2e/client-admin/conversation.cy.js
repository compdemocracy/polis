import { loginStandardUser, logout } from '../../support/auth-helpers.js'

import { getConversationDetails, conversationExists } from '../../support/conversation-helpers.js'

import { getPolisURL } from '../../support/admin-helpers.js'

describe('Client Admin: Conversation Management', () => {
  let testConversationId

  beforeEach(() => {
    // Clear any existing auth state
    logout()

    // Login as admin user for all tests using UI-based approach
    loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
  })

  describe('Create New Conversation', () => {
    it('should create a new conversation from the admin interface', () => {
      // The loginStandardUser function should have authenticated us and we should be on the conversations page
      // Should see the conversations list
      cy.get('h3').should('contain.text', 'All Conversations')

      // Click create new conversation button
      cy.get('button')
        .contains(/create new conversation/i)
        .click()

      // Should navigate to conversation creation/config page
      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)

      // Save the conversation ID from URL for later tests
      cy.url().then((url) => {
        const match = url.match(/\/m\/([a-zA-Z0-9]+)$/)
        if (match) {
          testConversationId = match[1]
          cy.log(`✅ Created conversation: ${testConversationId}`)
        }
      })

      // Should see the configure page
      cy.get('h3').should('contain.text', 'Configure')

      // Should see topic and description fields
      cy.get('input[data-testid="topic"]').should('be.visible')
      cy.get('textarea[data-testid="description"]').should('be.visible')
    })

    it('should allow configuring conversation details', () => {
      // Create a conversation first
      cy.visit('/')
      cy.get('button, a')
        .contains(/create new conversation/i)
        .click()

      // Wait for navigation and get conversation ID
      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)
      cy.url().then((url) => {
        const match = url.match(/\/m\/([a-zA-Z0-9]+)$/)
        testConversationId = match[1]
      })

      const timestamp = Date.now()
      const testTopic = `E2E Test Conversation ${timestamp}`
      const testDescription = `This is a test conversation created via e2e testing at ${new Date().toISOString()}`

      // Set up API intercepts to wait for the actual save requests
      cy.intercept('PUT', '/api/v3/conversations').as('updateConversation')

      // Fill in topic
      cy.get('input[data-testid="topic"]').should('not.be.disabled').clear().type(testTopic).blur() // Trigger the onBlur save

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Fill in description (ensure field is ready)
      cy.get('textarea[data-testid="description"]')
        .should('not.be.disabled')
        .clear()
        .type(testDescription)
        .blur() // Trigger the onBlur save

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Test some of the actual checkboxes from the page using their data-testid attributes
      // Toggle "vis_type" checkbox (Participants can see the visualization - unchecked by default)
      cy.get('input[data-testid="vis_type"]').should('not.be.checked').check()

      // Wait for this checkbox change to save
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Toggle "write_type" checkbox (Participants can submit comments - checked by default)
      cy.get('input[data-testid="write_type"]').should('be.checked').uncheck()

      // Wait for this checkbox change to save
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Verify the conversation exists via API
      cy.then(() => {
        if (testConversationId) {
          getConversationDetails(testConversationId).then((details) => {
            expect(details.topic).to.equal(testTopic)
            console.log(`✅ Conversation configured: ${details.topic}`)
          })
        }
      })
    })
  })

  describe('View Conversation List', () => {
    it('should display all conversations for the admin user', () => {
      cy.visit('/')

      // Should see conversations list
      cy.get('h3').should('contain.text', 'All Conversations')

      // Should see at least the default conversations or create button
      cy.get('body').should('contain.text', 'Create new conversation')

      // Check for existing conversations in the list
      cy.get('body').then(($body) => {
        if ($body.text().includes('Some Convo') || $body.text().includes('participants')) {
          cy.log('✅ Found existing conversations in the list')
          // Click on a conversation to test navigation
          cy.get('a, button')
            .contains(/Some Convo|participants|Just A Topic/)
            .first()
            .click()

          // Should navigate to conversation admin page
          cy.url().should('match', /\/m\/[a-zA-Z0-9]+/)
          cy.get('h1, h2, h3').should('contain.text', 'Configure')
        } else {
          cy.log('⚠️ No existing conversations found, which is fine for fresh environment')
        }
      })
    })

    it('should allow navigation between conversation admin sections', () => {
      // Create or use existing conversation
      cy.visit('/')

      // Either click existing conversation or create new one
      cy.get('body').then(($body) => {
        if ($body.text().includes('participants') && !$body.text().includes('0 participants')) {
          // Click existing conversation
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()
        } else {
          // Create new conversation
          cy.get('button, a')
            .contains(/create new conversation/i)
            .click()
        }
      })

      // Should be on configure page
      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)
      cy.get('h1, h2, h3').should('contain.text', 'Configure')

      // Test navigation to different sections
      const sections = [
        { link: 'Distribute', heading: 'Distribute', urlSegment: 'share' },
        { link: 'Moderate', heading: 'Moderate', urlSegment: 'comments' },
        { link: 'Monitor', heading: 'Monitor', urlSegment: 'stats' },
        { link: 'Report', heading: 'Report', urlSegment: 'reports' },
        { link: 'Configure', heading: 'Configure', urlSegment: '' }, // Configure is the base path
      ]

      sections.forEach((section) => {
        cy.log(`🧭 Testing navigation to ${section.link}`)

        // Click the navigation link
        cy.get('a').contains(section.link).click()

        // Wait for URL to change to the correct path segment
        if (section.urlSegment) {
          cy.url().should('include', section.urlSegment)
        } else {
          // For Configure, check that we're at the base conversation URL
          cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)
        }

        // Wait for the page content to load and find the specific heading
        cy.contains('h1, h2, h3', section.heading).should('be.visible')

        cy.log(`✅ Successfully navigated to ${section.link}`)
      })
    })
  })

  describe('Add Seed Comments', () => {
    it('should allow adding seed comments to a conversation', () => {
      // Create a new conversation
      cy.visit('/')
      cy.get('button, a')
        .contains(/create new conversation/i)
        .click()

      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)

      // Look for seed comments section
      cy.get('body').should('contain.text', 'Seed Comments')

      const testComments = [
        'Should we implement this feature?',
        'This could have environmental benefits',
        'Cost considerations need to be evaluated',
      ]

      // Set up API intercept for comment submissions
      cy.intercept('POST', '/api/v3/comments').as('addSeedComment')

      // Add seed comments individually
      testComments.forEach((comment, index) => {
        cy.log(`Adding seed comment ${index + 1}/${testComments.length}: ${comment}`)

        cy.get('textarea[data-testid="seed_form"]').clear().type(comment)

        // Submit this comment
        cy.get('button')
          .contains(/submit/i)
          .click()

        // Wait for this comment to be added
        cy.wait('@addSeedComment').then((interception) => {
          expect(interception.response.statusCode).to.eq(200)
        })

        // Small delay between comments
        cy.wait(500)
      })

      cy.log('✅ All seed comments added successfully')
    })
  })

  describe('Distribute Conversation', () => {
    it('should provide sharing and embedding options', () => {
      // Navigate to existing conversation or create new one
      cy.visit('/')

      cy.get('body').then(($body) => {
        if ($body.text().includes('participants')) {
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()
        } else {
          cy.get('button, a')
            .contains(/create new conversation/i)
            .click()
        }
      })

      // Navigate to Distribute section
      cy.get('a').contains('Distribute').click()
      cy.url().should('include', 'share')
      cy.get('h1, h2, h3').should('contain.text', 'Distribute')

      // Should see sharing URL
      cy.get('body').should('contain.text', 'Share')

      const { host: polisHost } = getPolisURL()

      cy.get(`a[href*="${polisHost}"], input[value*="${polisHost}"]`).should('exist')

      // Should see embed code
      cy.get('body').should('contain.text', 'Embed')
      cy.get('code, pre, textarea')
        .contains(/polis|embed/)
        .should('exist')

      // Should see XID information
      cy.get('body').should('contain.text', 'XID')

      cy.log('✅ Distribute page shows sharing and embedding options')
    })

    it('should display conversation URL for sharing', () => {
      cy.visit('/')

      cy.get('body').then(($body) => {
        if ($body.text().includes('participants')) {
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()

          cy.get('a').contains('Distribute').click()

          const { host: polisHost } = getPolisURL()

          // Check for conversation URL
          cy.get(`a[href*="${polisHost}"], input[value*="${polisHost}"], code`)
            .should('exist')
            .then(($el) => {
              const url = $el.attr('href') || $el.val() || $el.text()
              expect(url).to.match(
                new RegExp(`${polisHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-zA-Z0-9]+`),
              )
              cy.log(`✅ Found conversation URL: ${url}`)
            })
        }
      })
    })
  })

  describe('Moderate Comments', () => {
    it('should display comment moderation interface', () => {
      cy.visit('/')

      cy.get('body').then(($body) => {
        if ($body.text().includes('participants')) {
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()

          // Navigate to Moderate section
          cy.get('a[data-testid="moderate-comments"], a').contains('Moderate').click()

          cy.url().should('include', 'comments')
          cy.get('h1, h2, h3, body').should('contain.text', 'Moderate')

          cy.log('✅ Moderation interface accessible')
        }
      })
    })
  })

  describe('Monitor Conversation', () => {
    it('should display conversation statistics and monitoring', () => {
      cy.visit('/')

      cy.get('body').then(($body) => {
        if ($body.text().includes('participants')) {
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()

          // Navigate to Monitor section
          cy.get('a').contains('Monitor').click()

          cy.url().should('include', 'stats')
          cy.get('h1, h2, h3, body').should('contain.text', 'Monitor')

          cy.log('✅ Monitoring interface accessible')
        }
      })
    })
  })

  describe('Generate Reports', () => {
    it('should display reporting interface', () => {
      cy.visit('/')

      cy.get('body').then(($body) => {
        if ($body.text().includes('participants')) {
          cy.get('a')
            .contains(/participants/)
            .first()
            .click()

          // Navigate to Report section
          cy.get('a').contains('Report').click()

          cy.url().should('include', 'reports')
          cy.get('h1, h2, h3, body').should('contain.text', 'Report')

          cy.log('✅ Reporting interface accessible')
        }
      })
    })
  })

  describe('Conversation Workflow Integration', () => {
    it('should complete full conversation creation and configuration workflow', () => {
      const timestamp = Date.now()
      const testTopic = `Full Workflow Test ${timestamp}`
      const testDescription = `Complete e2e test conversation - ${new Date().toISOString()}`

      // 1. Create conversation
      cy.visit('/')
      cy.get('button, a')
        .contains(/create new conversation/i)
        .click()

      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)

      // Store conversation ID
      cy.url().then((url) => {
        const match = url.match(/\/m\/([a-zA-Z0-9]+)$/)
        testConversationId = match[1]
      })

      // Set up API intercepts like the other robust tests
      cy.intercept('PUT', '/api/v3/conversations').as('updateConversation')

      // 2. Configure basic settings with specific selectors
      // Trigger the onBlur save
      cy.get('input[data-testid="topic"]').should('not.be.disabled').clear().type(testTopic).blur()

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      cy.get('textarea[data-testid="description"]')
        .should('not.be.disabled')
        .clear()
        .type(testDescription)
        .blur() // Trigger the onBlur save

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // 3. Add seed comments individually
      const workflowComments = [
        'Seed comment 1: What do you think?',
        'Seed comment 2: This is important',
        'Seed comment 3: Consider the alternatives',
      ]

      cy.intercept('POST', '/api/v3/comments').as('addWorkflowComment')

      workflowComments.forEach((comment, index) => {
        cy.log(`Adding workflow comment ${index + 1}/${workflowComments.length}: ${comment}`)

        cy.get('textarea[data-testid="seed_form"]').clear().type(comment)

        cy.get('button')
          .contains(/submit/i)
          .click()

        cy.wait('@addWorkflowComment').then((interception) => {
          expect(interception.response.statusCode).to.eq(200)
        })

        cy.wait(500)
      })

      // 4. Test navigation through all sections
      const workflowSections = [
        { name: 'Distribute', urlSegment: 'share' },
        { name: 'Moderate', urlSegment: 'comments' },
        { name: 'Monitor', urlSegment: 'stats' },
        { name: 'Report', urlSegment: 'reports' },
        { name: 'Configure', urlSegment: '' }, // Configure is the base path
      ]

      workflowSections.forEach((section) => {
        cy.log(`🧭 Testing navigation to ${section.name}`)

        cy.get('a').contains(section.name).click()

        // Wait for URL to change to the correct path segment
        if (section.urlSegment) {
          cy.url().should('include', section.urlSegment)
        } else {
          // For Configure, check that we're at the base conversation URL
          cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)
        }

        // Wait for the page content to load and find the specific heading
        cy.contains('h1, h2, h3', section.name).should('be.visible')

        cy.log(`✅ Successfully navigated to ${section.name}`)
      })

      // 5. Verify conversation exists via API
      cy.then(() => {
        if (testConversationId) {
          conversationExists(testConversationId).then((exists) => {
            expect(exists).to.be.true
            cy.log(`✅ Conversation ${testConversationId} confirmed to exist`)
          })
        }
      })

      cy.log('✅ Complete workflow test passed')
    })
  })
})
