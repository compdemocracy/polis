import { loginStandardUser, logout } from '../../support/auth-helpers.js'
import {
  createTestConversation,
  addCommentsToConversation,
  participateInConversation,
} from '../../support/conversation-helpers.js'
import { navigateToConversationSection } from '../../support/admin-helpers.js'

describe('Client Admin: Comment Moderation', () => {
  let conversationId
  const seedComments = [
    'This is a seed comment that should be auto-approved',
    'Another seed comment for testing moderation',
    'Third seed comment to test the system',
  ]

  const participantComments = [
    { text: 'This comment needs moderation', pid: null },
    { text: 'Another comment from a participant', pid: null },
    { text: 'Third participant comment for testing', pid: null },
  ]

  before(() => {
    cy.log('🔧 Setting up conversation for comment moderation tests')

    // Logout any existing user
    logout()

    // Create a conversation and store the ID
    createTestConversation({
      topic: 'Comment Moderation Test',
      description: 'Testing comment moderation features',
      userEmail: 'admin@polis.test',
      userPassword: 'Te$tP@ssw0rd*',
    })
      .then((convId) => {
        conversationId = convId
        cy.log(`✅ Created conversation: ${conversationId}`)

        // Add seed comments to the conversation using the same admin user
        return addCommentsToConversation(
          conversationId,
          seedComments,
          'admin@polis.test',
          'Te$tP@ssw0rd*',
        )
      })
      .then(() => {
        cy.log(`✅ Added ${seedComments.length} seed comments to conversation ${conversationId}`)

        // Have participants add comments
        cy.log('🗣️ Adding participant comments')

        // Logout admin and participate as anonymous users
        logout()

        // Add participant comments sequentially
        participantComments.forEach((comment, index) => {
          cy.then(() => {
            return participateInConversation(conversationId, {
              comments: [comment.text],
            }).then((participation) => {
              // Store the participant ID for later reference if needed
              participantComments[index].pid = participation.pid
              cy.log(`✅ Participant ${index + 1} added comment`)
            })
          })
        })

        return cy.wrap(null)
      })
      .then(() => {
        cy.log('✅ All participant comments added')
      })
  })

  describe('Moderation Settings', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should toggle "No comments shown without moderator approval" setting', () => {
      // Navigate to conversation configuration
      cy.visit(`/m/${conversationId}`)
      cy.get('h1, h2, h3').should('contain.text', 'Configure')

      // Set up API intercept to monitor the setting change
      cy.intercept('PUT', '/api/v3/conversations').as('updateModeration')

      // Find and toggle the moderation checkbox
      // The setting might be named 'strict_moderation' or similar
      cy.get('input[type="checkbox"]').then(($checkboxes) => {
        // Look for checkbox related to moderation
        const moderationCheckbox = Array.from($checkboxes).find((cb) => {
          const label = cb.parentElement?.textContent || ''
          return label.toLowerCase().includes('moderat') || label.toLowerCase().includes('approv')
        })

        if (moderationCheckbox) {
          // Work directly with the element wrapped in Cypress
          cy.wrap(moderationCheckbox)
            .invoke('prop', 'checked')
            .then((isChecked) => {
              cy.log(`Moderation currently ${isChecked ? 'enabled' : 'disabled'}`)
              cy.wrap(moderationCheckbox).click()

              // Wait for update
              cy.wait('@updateModeration').then((interception) => {
                expect(interception.response.statusCode).to.eq(200)
                cy.log(`✅ Moderation toggled to ${!isChecked ? 'enabled' : 'disabled'}`)
              })

              // Toggle back
              cy.wrap(moderationCheckbox).click()
              cy.wait('@updateModeration').then((interception) => {
                expect(interception.response.statusCode).to.eq(200)
                cy.log(`✅ Moderation toggled back to ${isChecked ? 'enabled' : 'disabled'}`)
              })
            })
        }
      })
    })
  })

  describe('Comment Lists', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
      navigateToConversationSection(conversationId, 'moderate')
    })

    it('should show unmoderated comments on the moderation page', () => {
      cy.log('📋 Checking for unmoderated comments')

      // Should be on unmoderated by default, but ensure we're on the right tab
      cy.get('[data-testid="mod-queue"]').click()

      // Verify we're on the unmoderated section
      cy.get('[data-testid="pending-comment"]').should('exist')

      // Should see participant comments that need moderation
      participantComments.forEach((comment) => {
        cy.get('body').should('contain.text', comment.text)
      })

      cy.log('✅ Unmoderated comments are visible')
    })

    it('should show accepted comments section', () => {
      cy.log('📋 Checking accepted comments section')

      // Click on the accepted tab using the proper test ID
      cy.get('[data-testid="filter-approved"]').click()

      // Verify we're on the accepted section
      cy.get('[data-testid="approved-comments"]').should('exist')

      // URL should include 'accepted'
      cy.url().should('include', '/accepted')

      // Seed comments should be here as they're auto-approved
      seedComments.forEach((comment) => {
        cy.get('[data-testid="approved-comments"]').should('contain.text', comment)
      })

      cy.log('✅ Accepted comments section accessible and shows seed comments')
    })

    it('should show rejected comments section', () => {
      cy.log('📋 Checking rejected comments section')

      // Click on the rejected tab using the proper test ID
      cy.get('[data-testid="filter-rejected"]').click()

      // Verify we're on the rejected section
      cy.get('[data-testid="rejected-comments"]').should('exist')

      // URL should include 'rejected'
      cy.url().should('include', '/rejected')

      cy.log('✅ Rejected comments section accessible')
    })
  })

  describe('Comment Actions', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
      navigateToConversationSection(conversationId, 'moderate')
    })

    it('should allow approving a comment', () => {
      cy.log('✅ Testing comment approval')

      // Set up API intercept for comment moderation
      cy.intercept('PUT', '/api/v3/comments').as('moderateComment')

      // Ensure we're on the unmoderated tab
      cy.get('[data-testid="mod-queue"]').click()

      // Find the first participant comment and approve it
      const testComment = participantComments[0].text

      // Find the comment card containing our test comment
      cy.contains('[data-testid="pending-comment"]', testComment).within(() => {
        // Click the accept button (text is "accept" based on the component)
        cy.contains('button', 'accept').click()
      })

      // Wait for API call
      cy.wait('@moderateComment').then((interception) => {
        expect(interception.response.statusCode).to.be.oneOf([200, 204])
        cy.log('✅ Comment approved successfully')

        // Verify the request body contains mod: 1 for approval
        expect(interception.request.body).to.have.property('mod', 1)
      })

      // Verify the comment moved to accepted section
      cy.get('[data-testid="filter-approved"]').click()
      cy.get('[data-testid="approved-comments"]').should('contain.text', testComment)
    })

    it('should allow rejecting a comment', () => {
      cy.log('❌ Testing comment rejection')

      // Set up API intercept for comment moderation
      cy.intercept('PUT', '/api/v3/comments').as('moderateComment')

      // Ensure we're on the unmoderated tab
      cy.get('[data-testid="mod-queue"]').click()

      // Find the second participant comment and reject it
      const testComment = participantComments[1].text

      // Find the comment card containing our test comment
      cy.contains('[data-testid="pending-comment"]', testComment).within(() => {
        // Click the reject button using its test ID
        cy.get('[data-testid="reject-comment"]').click()
      })

      // Wait for API call
      cy.wait('@moderateComment').then((interception) => {
        expect(interception.response.statusCode).to.be.oneOf([200, 204])
        cy.log('✅ Comment rejected successfully')

        // Verify the request body contains mod: -1 for rejection
        expect(interception.request.body).to.have.property('mod', -1)
      })

      // Verify the comment moved to rejected section
      cy.get('[data-testid="filter-rejected"]').click()
      cy.get('[data-testid="rejected-comments"]').should('contain.text', testComment)
    })
  })

  describe('Seed Comments', () => {
    beforeEach(() => {
      logout()
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')
    })

    it('should show seed comments as automatically approved', () => {
      cy.log('🌱 Verifying seed comments are auto-approved')

      // Navigate to moderation and then accepted comments
      navigateToConversationSection(conversationId, 'moderate')
      cy.get('[data-testid="filter-approved"]').click()

      // All seed comments should be visible in accepted section
      seedComments.forEach((comment) => {
        cy.get('[data-testid="approved-comments"]').should('contain.text', comment)
      })

      cy.log('✅ All seed comments are automatically approved')
    })

    it('should not show seed comments in unmoderated section', () => {
      cy.log('🌱 Verifying seed comments are not in unmoderated')

      navigateToConversationSection(conversationId, 'moderate')

      // Should be on unmoderated by default, but ensure we're on the right tab
      cy.get('[data-testid="mod-queue"]').click()

      // Seed comments should NOT be in the unmoderated section
      seedComments.forEach((comment) => {
        // Check specifically within the pending comments container
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="pending-comment"]').length > 0) {
            // Only check if there are pending comments
            cy.get('[data-testid="pending-comment"]').each(($el) => {
              cy.wrap($el).should('not.contain.text', comment)
            })
          }
        })
      })

      cy.log('✅ Seed comments are not in unmoderated section')
    })
  })
})
