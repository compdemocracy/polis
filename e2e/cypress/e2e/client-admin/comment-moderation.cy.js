describe('Comment Moderation', function () {
  beforeEach(function () {
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/comments*').as('getComments')
    cy.intercept('POST', '/api/v3/comments').as('createComment')
    cy.intercept('PUT', '/api/v3/comments*').as('updateComment')
    cy.intercept('PUT', '/api/v3/mod/comments*').as('moderateComment')

    // Create a conversation and add some comments
    cy.createConvo().then(() => {
      cy.visit('/m/' + this.convoId)
      cy.wait('@getConversations')

      // Set up initial comments
      cy.get('textarea[data-test-id="seed_form"]').type('Initial comment for moderation')
      cy.get('button').contains('Submit').click()
      cy.wait('@createComment')
    })
  })

  describe('Basic Moderation Actions', function () {
    it('should reject an approved comment', function () {
      cy.get('[data-test-id="moderate-comments"]').click()
      cy.get('[data-test-id="filter-approved"]').click()
      cy.get('[data-test-id="reject-comment"]').click()
      cy.wait('@updateComment').then(({ response }) => {
        expect(response.statusCode).to.equal(200)
      })
      cy.get('[data-test-id="pending-comment"]').should('not.exist')
      cy.get('[data-test-id="filter-rejected"]').click()
      cy.contains('button', 'accept').click()
      cy.wait('@updateComment').then(({ response }) => {
        expect(response.statusCode).to.equal(200)
      })
    })
  })

  describe('Moderation Settings', function () {
    it('should filter comments by moderation status', function () {
      cy.get('[data-test-id="moderate-comments"]').click()

      // Test different filter options
      cy.get('[data-test-id="filter-approved"]').click()
      cy.get('[data-test-id="approved-comments"]').should('be.visible')

      cy.get('[data-test-id="filter-rejected"]').click()
      cy.get('[data-test-id="rejected-comments"]').should('exist')

      cy.get('[data-test-id="mod-queue"]').click()
      cy.get('[data-test-id="pending-comment"]').should('exist')
    })
  })
})
