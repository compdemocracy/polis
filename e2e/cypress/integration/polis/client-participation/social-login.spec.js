describe('Social login', () => {
  before(function () {
    cy.fixture('users.json').then((users) => {
      const user = users.moderator
      cy.createConvo(user.email, user.password)
    })

    cy.location('pathname').then((adminPath) => {
      const convoId = adminPath.replace('/m/', '')
      cy.wrap(convoId).as('convoId')
    })

    // Ensure social login is enabled for all participant interactions.
    cy.get('input[data-test-id="auth_needed_to_write"]').check()
    cy.get('input[data-test-id="auth_needed_to_vote"]').check()

    // Ensure at least one comment to vote on.
    // TODO: Refactor as command.
    cy.route('POST', Cypress.config().apiPath + '/comments').as('newSeed')
    cy.get('textarea[data-test-id="seed_form"]').type('I feel that foo.')

    // This button sometimes doesn't succeed. Can possibly fix if needed.
    // See: https://docs.cypress.io/guides/core-concepts/retry-ability.html#Why-are-some-commands-NOT-retried
    cy.contains('button', 'Submit').click()
    cy.wait('@newSeed').then((xhr) => {
      expect(xhr.status).to.equal(200)
    })
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
