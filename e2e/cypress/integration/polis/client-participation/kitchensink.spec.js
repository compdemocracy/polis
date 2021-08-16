describe('Kitchen Sink Participation', () => {

  function submitVotes(participantVotes, convoId) {
    cy.server()
    cy.route('POST', Cypress.config().apiPath + '/votes').as('newVote')
    cy.route('GET', Cypress.config().apiPath + '/participationInit?*').as('initConvo')

    participantVotes.forEach((votes) => {

      cy.clearCookies()
      cy.visit(`/${convoId}`)
      cy.wait('@initConvo')
      for (var i = 0; i < votes.length; i++) {
        if (votes.charAt(i) === 'A') {
          cy.get('#agreeButton').click()
        } else if (votes.charAt(i) === 'D') {
          cy.get('#disagreeButton').click()
        }
        cy.wait('@newVote')
      }
    })
  }

  before(function () {
    cy.createConvo('moderator').then(() => {

      [ 1, 2, 3 ].forEach((i) => {
        cy.seedComment(`Seed comment #${i}`, this.convoId)
        cy.wait(250)
      })

      cy.visit(`/m/${this.convoId}`)
      cy.get('input[data-test-id="vis_type"]').check().should('be.checked')
      cy.get('input[data-test-id="write_type"]').check().should('be.checked')
      cy.get('input[data-test-id="strict_moderation"]').check().should('be.checked')
      cy.get('input[data-test-id="auth_needed_to_write"]').uncheck().should('not.be.checked')
      cy.get('input[data-test-id="auth_needed_to_vote"]').uncheck().should('not.be.checked')


      // Moderator will have implicitly voted on seed comment, so log out.
      // See: https://github.com/pol-is/polisServer/issues/373
      cy.logout()

      const preVisualizationVotes = [
        'AAD',
        'AAD',
        'AAA',
        'DDD',
        'DAD',
      ]

      submitVotes(preVisualizationVotes, this.convoId)
    })
  })

  it("shows the visualization after 7 participants", function () {
    cy.visit(`/${this.convoId}`)

    // Confirm visualization won't show at 6 participants.
    cy.wait(2000)
    cy.get('#vis_not_yet_label').should('be.visible')
    cy.get('#vis2_root > div').should('not.exist')

    // Confirm visualization does show after 7 participants.
    submitVotes(['DDD'], this.convoId)
    cy.wait(2000)
    cy.get('#vis_not_yet_label').should('not.be.visible')
    cy.get('#vis2_root > div').should('exist')

  })
})
