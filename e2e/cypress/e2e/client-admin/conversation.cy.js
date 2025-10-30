import { loginStandardUser, loginStandardUserAPI, logout } from '../../support/auth-helpers.js'

import {
  getConversationDetails,
  conversationExists,
  createTestConversationAPI,
  addCommentsToConversation,
} from '../../support/conversation-helpers.js'

import { getPolisURL } from '../../support/admin-helpers.js'

describe('Client Admin: Conversation Management', () => {
  let testConversationId
  let preExistingConversationId
  const preExistingSeedComments = [
    'First comment on pre-existing conversation',
    'Second comment on pre-existing conversation',
    'Third comment on pre-existing conversation',
  ]

  before(() => {
    // Create a conversation that will exist for all tests
    loginStandardUserAPI('admin@polis.test', 'Te$tP@ssw0rd*')
      .then(() => {
        return createTestConversationAPI({
          topic: 'Pre-existing Test Conversation',
          description: 'This conversation exists before each test runs',
          visualizationEnabled: true,
        })
      })
      .then((convId) => {
        preExistingConversationId = convId
        cy.log(`✅ Created pre-existing conversation: ${preExistingConversationId}`)

        // Add some comments to make it more interesting
        return addCommentsToConversation(preExistingConversationId, preExistingSeedComments)
      })
  })

  beforeEach(() => {
    // Clear any existing auth state
    logout()

    // Login as admin user for all tests using UI-based approach
    loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
  })

  describe('Create New Conversation', () => {
    it('should create a new conversation from the admin interface', () => {
      // Should see the conversations list
      cy.get('h3').should('contain.text', 'All Conversations')

      // Verify our pre-existing conversation is in the list
      cy.contains('Pre-existing Test Conversation').should('exist')

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
      cy.get('button')
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
      cy.get('input[data-testid="topic"]').should('not.be.disabled')
      cy.get('input[data-testid="topic"]').clear()
      cy.get('input[data-testid="topic"]').type(testTopic)
      cy.get('input[data-testid="topic"]').blur()

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Fill in description
      cy.get('textarea[data-testid="description"]').should('not.be.disabled')
      cy.get('textarea[data-testid="description"]').clear()
      cy.get('textarea[data-testid="description"]').type(testDescription)
      cy.get('textarea[data-testid="description"]').blur()

      // Wait for the actual API call to complete
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      // Test checkboxes
      cy.get('input[data-testid="vis_type"]').should('not.be.checked').check()
      cy.wait('@updateConversation').then((interception) => {
        expect(interception.response.statusCode).to.eq(200)
      })

      cy.get('input[data-testid="write_type"]').should('be.checked').uncheck()
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

      // Should see the create button
      cy.get('button').contains('Create new conversation').should('exist')

      // Should see our pre-existing conversation in the list
      // Look for conversation cards by their content structure (topic + participants)
      cy.contains('participants').should('exist')

      // Find the pre-existing conversation by its topic text
      cy.contains('Pre-existing Test Conversation').should('exist')

      // Verify the conversation structure exists
      cy.contains('This conversation exists before each test runs').should('exist')
    })

    it('should allow navigation between conversation admin sections', () => {
      cy.visit('/')

      // Click on the pre-existing conversation
      cy.contains('Pre-existing Test Conversation').click()

      // Should navigate to conversation admin page
      cy.url().should('include', `/m/${preExistingConversationId}`)
      cy.get('h3').should('contain.text', 'Configure')

      // Test navigation to different sections
      const sections = [
        { link: 'Distribute', heading: 'Distribute', urlSegment: 'share' },
        { link: 'Moderate', heading: 'Moderate', urlSegment: 'comments' },
        { link: 'Monitor', heading: 'Monitor', urlSegment: 'stats' },
        { link: 'Report', heading: 'Report', urlSegment: 'reports' },
        { link: 'Configure', heading: 'Configure', urlSegment: '' },
      ]

      sections.forEach((section) => {
        cy.log(`🧭 Testing navigation to ${section.link}`)

        // Click the navigation link
        cy.get('a').contains(section.link).click()

        // Wait for URL to change
        if (section.urlSegment) {
          cy.url().should('include', section.urlSegment)
        } else {
          cy.url().should('match', new RegExp(`/m/${preExistingConversationId}$`))
        }

        // Wait for page to load and heading to appear with timeout
        cy.contains('h1, h2, h3', section.heading, { timeout: 10000 }).should('be.visible')

        cy.log(`✅ Successfully navigated to ${section.link}`)
      })
    })
  })

  describe('Add Seed Comments', () => {
    it('should allow adding seed comments to a conversation', () => {
      // Navigate to the pre-existing conversation
      cy.visit(`/m/${preExistingConversationId}`)

      // Should be on configure page
      cy.get('h3').should('contain.text', 'Configure')

      // Look for seed comments section
      cy.contains('Seed Comments').should('exist')

      const testComments = [
        'Should we implement this feature?',
        'This could have environmental benefits',
        'Cost considerations need to be evaluated',
      ]

      // Set up API intercept for comment submissions
      cy.intercept('POST', '/api/v3/comments').as('addSeedComment')

      // Add seed comments
      testComments.forEach((comment, index) => {
        cy.log(`Adding seed comment ${index + 1}/${testComments.length}: ${comment}`)

        cy.get('textarea[data-testid="seed_form"]').clear()
        cy.get('textarea[data-testid="seed_form"]').type(comment)
        cy.get('button')
          .contains(/submit/i)
          .click()

        cy.wait('@addSeedComment').then((interception) => {
          expect(interception.response.statusCode).to.eq(200)
        })
      })

      cy.log('✅ All seed comments added successfully')
    })
  })

  describe('Distribute Conversation', () => {
    it('should provide sharing and embedding options', () => {
      // Navigate to the pre-existing conversation
      cy.visit(`/m/${preExistingConversationId}`)

      // Navigate to Distribute section
      cy.get('a').contains('Distribute').click()
      cy.url().should('include', 'share')
      cy.get('h3').should('contain.text', 'Distribute')

      // Should see sharing URL
      cy.contains('Share').should('exist')

      const { host: polisHost } = getPolisURL()

      // Check for conversation URL - be more flexible with the selector
      cy.get('body').should('contain', polisHost)

      // Should see embed code section
      cy.contains('Embed').should('exist')

      // Should see XID information
      cy.contains('XID').should('exist')

      cy.log('✅ Distribute page shows sharing and embedding options')
    })

    it('should display conversation URL for sharing', () => {
      cy.visit(`/m/${preExistingConversationId}/share`)

      const { host: polisHost } = getPolisURL()

      // Wait for the body to contain the conversation URL
      cy.get('body').should('contain.text', `${polisHost}/${preExistingConversationId}`)
      cy.log(`✅ Found conversation URL in page`)
    })
  })

  describe('Moderate Comments', () => {
    it('should display comment moderation interface', () => {
      cy.visit(`/m/${preExistingConversationId}`)

      // Navigate to Moderate section
      cy.get('a').contains('Moderate').click()
      cy.url().should('include', 'comments')

      // Should show moderation interface
      cy.get('h3').should('contain.text', 'Moderate')

      // Navigate to Accepted and verify pre-existing seed comments are visible
      cy.get('[data-testid="filter-approved"]').click()
      preExistingSeedComments.forEach((txt) => {
        cy.get('body').should('contain.text', txt)
      })

      cy.log('✅ Moderation interface accessible')
    })
  })

  describe('Monitor Conversation', () => {
    it('should display conversation statistics and monitoring', () => {
      cy.visit(`/m/${preExistingConversationId}`)

      // Navigate to Monitor section
      cy.get('a').contains('Monitor').click()
      cy.url().should('include', 'stats')
      cy.get('h3').should('contain.text', 'Monitor')

      cy.log('✅ Monitoring interface accessible')
    })
  })

  describe('Generate Reports', () => {
    it('should display reporting interface', () => {
      cy.visit(`/m/${preExistingConversationId}`)

      // Navigate to Report section
      cy.get('a').contains('Report').click()
      cy.url().should('include', 'reports')
      cy.get('h3').should('contain.text', 'Report')

      cy.log('✅ Reporting interface accessible')
    })
  })

  describe('Conversation Workflow Integration', () => {
    it('should complete full conversation creation and configuration workflow', () => {
      const timestamp = Date.now()
      const testTopic = `Full Workflow Test ${timestamp}`
      const testDescription = `Complete e2e test conversation - ${new Date().toISOString()}`

      // 1. Create conversation
      cy.visit('/')
      cy.get('button')
        .contains(/create new conversation/i)
        .click()

      cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)

      // Store conversation ID
      cy.url().then((url) => {
        const match = url.match(/\/m\/([a-zA-Z0-9]+)$/)
        testConversationId = match[1]
      })

      // Set up API intercepts
      cy.intercept('PUT', '/api/v3/conversations').as('updateConversation')

      // 2. Configure basic settings
      cy.get('input[data-testid="topic"]').clear()
      cy.get('input[data-testid="topic"]').type(testTopic)
      cy.get('input[data-testid="topic"]').blur()
      cy.wait('@updateConversation')

      cy.get('textarea[data-testid="description"]').clear()
      cy.get('textarea[data-testid="description"]').type(testDescription)
      cy.get('textarea[data-testid="description"]').blur()
      cy.wait('@updateConversation')

      // 3. Add seed comments
      const workflowComments = [
        'Workflow comment 1: What do you think?',
        'Workflow comment 2: This is important',
        'Workflow comment 3: Consider the alternatives',
      ]

      cy.intercept('POST', '/api/v3/comments').as('addWorkflowComment')

      workflowComments.forEach((comment) => {
        cy.get('textarea[data-testid="seed_form"]').clear()
        cy.get('textarea[data-testid="seed_form"]').type(comment)
        cy.get('button')
          .contains(/submit/i)
          .click()
        cy.wait('@addWorkflowComment')
      })

      // 4. Test navigation through all sections
      const workflowSections = [
        { name: 'Distribute', urlSegment: 'share' },
        { name: 'Moderate', urlSegment: 'comments' },
        { name: 'Monitor', urlSegment: 'stats' },
        { name: 'Report', urlSegment: 'reports' },
        { name: 'Configure', urlSegment: '' },
      ]

      workflowSections.forEach((section) => {
        cy.log(`🧭 Testing workflow navigation to ${section.name}`)

        cy.get('a').contains(section.name).click()

        // Wait for URL to change
        if (section.urlSegment) {
          cy.url().should('include', section.urlSegment)
        } else {
          cy.url().should('match', /\/m\/[a-zA-Z0-9]+$/)
        }

        // Wait for page to load and heading to appear
        cy.contains('h1, h2, h3', section.name, { timeout: 10000 }).should('be.visible')

        cy.log(`✅ Successfully navigated to ${section.name} in workflow`)
      })

      // 5. Verify conversation exists
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
