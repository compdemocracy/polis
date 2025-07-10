/**
 * Admin workflow helpers for Polis E2E tests
 * Provides utilities for testing admin interface functionality
 */

/**
 * Get the participant URL and host from environment variables
 * @returns {object} Object with url and host properties
 */
export function getPolisURL() {
  const participantUrl = Cypress.config('baseUrl')
  const polisHost = new URL(participantUrl).host

  return {
    url: participantUrl,
    host: polisHost,
  }
}

/**
 * Navigate to a specific conversation admin section
 * @param {string} conversationId - The conversation ID
 * @param {string} section - The section to navigate to (configure, share, comments, stats, reports)
 */
export function navigateToConversationSection(conversationId, section = 'configure') {
  cy.log(`🧭 Navigating to ${section} section for conversation ${conversationId}`)

  const sectionMap = {
    configure: '',
    distribute: '/share',
    moderate: '/comments',
    monitor: '/stats',
    report: '/reports',
  }

  const path = sectionMap[section.toLowerCase()]
  if (path === undefined) {
    throw new Error(
      `Unknown section: ${section}. Valid sections: configure, distribute, moderate, monitor, report`,
    )
  }

  const url = `/m/${conversationId}${path}`
  cy.visit(url)

  // Verify we're on the correct page
  const expectedHeading = section.charAt(0).toUpperCase() + section.slice(1)
  cy.get('h1, h2, h3').should('contain.text', expectedHeading)

  cy.log(`✅ Navigated to ${section} section`)
}

/**
 * Extract conversation sharing URL from the distribute page
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<string>} - The sharing URL
 */
export function getConversationSharingURL(conversationId) {
  cy.log(`🔗 Getting sharing URL for conversation ${conversationId}`)

  // Navigate to distribute section
  navigateToConversationSection(conversationId, 'distribute')

  const { host: polisHost } = getPolisURL()

  // Find and return the sharing URL
  return cy
    .get(`a[href*="${polisHost}"], input[value*="${polisHost}"], code`)
    .first()
    .then(($el) => {
      const url = $el.attr('href') || $el.val() || $el.text()
      cy.log(`✅ Found sharing URL: ${url}`)
      return url
    })
}

/**
 * Verify all required admin interface elements are present
 * @param {string} section - The section to verify (configure, distribute, etc.)
 */
export function verifyAdminInterfaceElements(section = 'configure') {
  cy.log(`🔍 Verifying admin interface elements for ${section} section`)

  switch (section.toLowerCase()) {
    case 'configure':
      cy.get('input[data-testid="topic"], input[id*="topic"]').should('be.visible')
      cy.get('textarea[data-testid="description"]').should('be.visible')
      cy.get('body').should('contain.text', 'Seed Comments')
      cy.get('button')
        .contains(/submit/i)
        .should('be.visible')
      break

    case 'distribute':
      cy.get('body').should('contain.text', 'Share')
      cy.get('body').should('contain.text', 'Embed')
      cy.get('body').should('contain.text', 'XID')
      break

    case 'moderate':
      cy.get('h1, h2, h3, body').should('contain.text', 'Moderate')
      break

    case 'monitor':
      cy.get('h1, h2, h3, body').should('contain.text', 'Monitor')
      break

    case 'report':
      cy.get('h1, h2, h3, body').should('contain.text', 'Report')
      break

    default:
      cy.log(`⚠️ Unknown section: ${section}`)
  }

  cy.log(`✅ Admin interface elements verified for ${section}`)
}

/**
 * Moderate a comment (approve or reject)
 * @param {string} conversationId - The conversation ID
 * @param {string} commentText - The comment text to moderate
 * @param {string} action - Either 'approve' or 'reject'
 */
export function moderateComment(conversationId, commentText, action) {
  cy.log(`${action === 'approve' ? '✅' : '❌'} ${action}ing comment: "${commentText}"`)

  // Navigate to moderation page
  navigateToConversationSection(conversationId, 'moderate')

  // Set up API intercept
  cy.intercept('PUT', '/api/v3/comments/*').as('moderateComment')

  // Find the comment
  cy.contains(commentText)
    .parent()
    .within(() => {
      // Look for action button
      cy.get('button, a').then(($buttons) => {
        const actionBtn = Array.from($buttons).find((btn) =>
          btn.textContent?.toLowerCase().includes(action.toLowerCase()),
        )

        if (actionBtn) {
          cy.wrap(actionBtn).click()

          // Wait for API call
          cy.wait('@moderateComment').then((interception) => {
            expect(interception.response.statusCode).to.be.oneOf([200, 204])
            cy.log(`✅ Comment ${action}d successfully`)
          })
        } else {
          cy.log(`⚠️ ${action} button not found for comment`)
        }
      })
    })
}
