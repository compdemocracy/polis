describe('Conversation: Closing', () => {
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
