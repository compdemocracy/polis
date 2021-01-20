describe('Conversation: Configure', () => {
  describe('Closing', () => {
    before(function () {
      cy.createConvo('moderator').then(() => {
        cy.visit(`/m/${this.convoId}`)
        // We must set the topic in order for "Closed" badge to display.
        // TODO: Allow badge to display without topic set.
        cy.get('input[data-test-id="topic"]').type('Dummy topic')
        cy.seedComment('Some seed statement', this.convoId)
        cy.get('input[data-test-id="is_active"]').uncheck().should('not.be.checked')
      })
    })

    it('responds properly to being closed', function () {
      cy.login('participant')
      cy.visit(`/${this.convoId}`)
      cy.get('.no_you_vote').should('be.visible')
      cy.get('#readReactView').should('not.be.visible')
      cy.get('#commentFormParent').should('not.be.visible')
    })
  })

  describe('Defaults', () => {
    before(function () {
      cy.createConvo('moderator')
    })

    it('creates with proper defaults', function () {
      cy.visit(`/m/${this.convoId}`)
      // Customize section
      cy.get('input[data-test-id="vis_type"]').should('not.be.checked')
      cy.get('input[data-test-id="write_type"]').should('be.checked')
      cy.get('input[data-test-id="help_type"]').should('be.checked')
      cy.get('input[data-test-id="subscribe_type"]').should('be.checked')
      cy.get('input[data-test-id="auth_opt_fb"]').should('be.checked')
      cy.get('input[data-test-id="auth_opt_tw"]').should('be.checked')

      // Schemes section
      cy.get('input[data-test-id="is_active"]').should('be.checked')
      cy.get('input[data-test-id="strict_moderation"]').should('not.be.checked')
      cy.get('input[data-test-id="auth_needed_to_write"]').should('be.checked')
      cy.get('input[data-test-id="auth_needed_to_vote"]').should('not.be.checked')
    })
  })
})
