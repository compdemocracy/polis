describe('Social login', () => {
  before(function () {
    cy.createConvo('moderator').then(() => {
      cy.seedComment('I feel like foo.', this.convoId)
    })

    // Ensure social login is enabled for all participant interactions.
    cy.get('input[data-test-id="auth_needed_to_write"]').check()
    cy.get('input[data-test-id="auth_needed_to_vote"]').check()
  })

  beforeEach(function () {
    cy.login('moderator')
    cy.visit(`/m/${this.convoId}`)
    cy.get('input[data-test-id="auth_opt_tw"]').as('showTwitterCheckbox')
    cy.get('input[data-test-id="auth_opt_fb"]').as('showFacebookCheckbox')
    cy.get('@showTwitterCheckbox').check().should('be.checked')
    cy.get('@showFacebookCheckbox').check().should('be.checked')
    cy.logout()

    // Generate aliases for page elements.
    cy.visit(`/${this.convoId}`)
    // Click to make other buttons appear in DOM.
    cy.get('button#passButton').as('voteButton').click()
    cy.get('button#comment_button').as('commentButton').click()
    cy.get('button#twitterButtonVoteView').as('onVoteTwitterButton')
    cy.get('button#twitterButtonCommentForm').as('onCommentTwitterButton')
    cy.get('button#facebookButtonVoteView').as('onVoteFacebookButton')
    cy.get('button#facebookButtonCommentForm').as('onCommentFacebookButton')
  })

  it('allows Facebook to be disabled', function () {
    cy.login('moderator')
    cy.visit(`/m/${this.convoId}`)
    cy.get('@showFacebookCheckbox').uncheck().should('not.be.checked')
    cy.logout()

    cy.visit(`/${this.convoId}`)
    cy.get('@voteButton').click()
    cy.get('@onVoteTwitterButton').should('be.visible')
    cy.get('@onVoteFacebookButton').should('not.be.visible')

    cy.get('@commentButton').click()
    cy.get('@onCommentTwitterButton').should('be.visible')
    cy.get('@onCommentFacebookButton').should('not.be.visible')
  })

  it('allows Twitter to be disabled', function () {
    cy.login('moderator')
    cy.visit(`/m/${this.convoId}`)
    cy.get('@showTwitterCheckbox').uncheck().should('not.be.checked')
    cy.logout()

    cy.visit(`/${this.convoId}`)
    cy.get('@voteButton').click()
    cy.get('@onVoteTwitterButton').should('not.be.visible')
    cy.get('@onVoteFacebookButton').should('be.visible')

    cy.get('@commentButton').click()
    cy.get('@onCommentTwitterButton').should('not.be.visible')
    cy.get('@onCommentFacebookButton').should('be.visible')
  })

  it('allows both login providers to be enabled', function () {
    // Both providers enabled by default in beforeEach.

    cy.visit(`/${this.convoId}`)
    cy.get('@voteButton').click()
    cy.get('@onVoteTwitterButton').should('be.visible')
    cy.get('@onVoteFacebookButton').should('be.visible')

    cy.get('@commentButton').click()
    cy.get('@onCommentTwitterButton').should('be.visible')
    cy.get('@onCommentFacebookButton').should('be.visible')
  })

  // TODO: This state should actually be prevented through config page.
  it('allows both login providers to be hidden', function () {
    cy.login('moderator')
    cy.visit(`/m/${this.convoId}`)
    cy.get('@showTwitterCheckbox').uncheck().should('not.be.checked')
    cy.get('@showFacebookCheckbox').uncheck().should('not.be.checked')
    cy.logout()

    cy.visit(`/${this.convoId}`)
    cy.get('@voteButton').click()
    cy.get('@onVoteTwitterButton').should('not.be.visible')
    cy.get('@onVoteFacebookButton').should('not.be.visible')

    cy.get('@commentButton').click()
    cy.get('@onCommentTwitterButton').should('not.be.visible')
    cy.get('@onCommentFacebookButton').should('not.be.visible')
  })
})
