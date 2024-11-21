const voteView = '[data-view-name="vote-view"]'
const commentView = '[data-view-name="comment-form"]'
const facebookAuthOpt = 'input[data-test-id="auth_opt_fb"]'
const facebookCommentBtn = 'button#facebookButtonCommentForm'
const facebookVoteBtn = 'button#facebookButtonVoteView'
const twitterAuthOpt = 'input[data-test-id="auth_opt_tw"]'
const twitterCommentBtn = 'button#twitterButtonCommentForm'
const twitterVoteBtn = 'button#twitterButtonVoteView'
// skip this test for now
// eslint-disable-next-line mocha/no-skipped-tests
describe.skip('Social login buttons', function () {
  before(function () {
    cy.createConvo().then(() => {
      cy.seedComment(this.convoId)
      cy.wrap(`/m/${this.convoId}`).as('adminPath')
      cy.wrap(`/${this.convoId}`).as('convoPath')
    })
  })

  beforeEach(function () {
    cy.intercept('POST', '/api/v3/comments').as('postComment')
    cy.intercept('GET', '/api/v3/math/pca2*').as('getMath')
    cy.intercept('GET', '/api/v3/comments*').as('getComments')
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/users*').as('getUsers')
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
    cy.intercept('PUT', '/api/v3/conversations').as('putConversations')
    cy.intercept('GET', '/api/v3/conversationStats*').as('getConversationStats')
  })

  describe('default settings', function () {
    it('has the correct settings checked in the admin view', function () {
      cy.ensureUser('moderator')
      cy.visit(this.adminPath)

      cy.get(facebookAuthOpt).should('be.checked')
      cy.get(twitterAuthOpt).should('be.checked')
      cy.get('input[data-test-id="auth_needed_to_vote"]').should('not.be.checked')
      cy.get('input[data-test-id="auth_needed_to_write"]').should('be.checked')
    })

    it('requires social login to comment, but not to vote', function () {
      cy.ensureUser('participant')
      cy.visit(this.convoPath)
      cy.wait('@participationInit')
      cy.wait('@getComments')

      cy.vote()

      cy.get(voteView).find(facebookVoteBtn).should('not.exist')
      cy.get(voteView).find(twitterVoteBtn).should('not.exist')

      cy.get(commentView).find('button#comment_button').click()

      cy.get(commentView).find(facebookCommentBtn).should('be.visible')
      cy.get(commentView).find(twitterCommentBtn).should('be.visible')
    })
  })

  describe('social login required to vote and comment', function () {
    before(function () {
      cy.ensureUser('moderator')
      cy.visit(this.adminPath)

      cy.get('input[data-test-id="auth_needed_to_write"]').check()
      cy.get('input[data-test-id="auth_needed_to_vote"]').check()
    })

    it('prompts for social login to comment and vote', function () {
      cy.ensureUser('participant2')
      cy.visit(this.convoPath)
      cy.wait('@participationInit')
      cy.wait('@getComments')

      cy.vote()

      cy.get(voteView).find(facebookVoteBtn).should('be.visible')
      cy.get(voteView).find(twitterVoteBtn).should('be.visible')

      cy.get(commentView).find('button#comment_button').click()

      cy.get(commentView).find(facebookCommentBtn).should('be.visible')
      cy.get(commentView).find(twitterCommentBtn).should('be.visible')
    })

    it('allows Facebook to be disabled', function () {
      cy.ensureUser('moderator')
      cy.visit(this.adminPath)
      cy.get(facebookAuthOpt).uncheck()
      cy.get(twitterAuthOpt).check()

      cy.ensureUser('participant3')
      cy.visit(this.convoPath)
      cy.wait('@participationInit')
      cy.wait('@getComments')

      cy.vote()

      cy.get(voteView).find(facebookVoteBtn).should('not.exist')
      cy.get(voteView).find(twitterVoteBtn).should('be.visible')

      cy.get(commentView).find('button#comment_button').click()

      cy.get(commentView).find(facebookCommentBtn).should('not.exist')
      cy.get(commentView).find(twitterCommentBtn).should('be.visible')
    })

    it('allows Twitter to be disabled', function () {
      cy.ensureUser('moderator')
      cy.visit(this.adminPath)
      cy.get(facebookAuthOpt).check()
      cy.get(twitterAuthOpt).uncheck()

      cy.ensureUser('participant4')
      cy.visit(this.convoPath)
      cy.wait('@participationInit')
      cy.wait('@getComments')

      cy.vote()

      cy.get(voteView).find(facebookVoteBtn).should('be.visible')
      cy.get(voteView).find(twitterVoteBtn).should('not.exist')

      cy.get(commentView).find('button#comment_button').click()

      cy.get(commentView).find(facebookCommentBtn).should('be.visible')
      cy.get(commentView).find(twitterCommentBtn).should('not.exist')
    })

    it('allows both providers to be disabled and a user can vote and comment', function () {
      cy.ensureUser('moderator')
      cy.visit(this.adminPath)
      cy.get(facebookAuthOpt).uncheck()
      cy.get(twitterAuthOpt).uncheck()
      cy.get('input[data-test-id="auth_needed_to_write"]').uncheck() // testing to ensure commenting works
      cy.get('input[data-test-id="auth_needed_to_vote"]').uncheck() // testing to ensure commenting works
      // check monitor page
      cy.visit(`/m${this.convoPath}/stats`)
      cy.wait('@getConversationStats')
      cy.contains('2 participants voted').should('be.visible')
      cy.ensureUser('participant5')
      cy.visit(this.convoPath)
      cy.wait('@participationInit')
      cy.wait('@getComments')

      cy.vote()

      cy.get(voteView).find(facebookVoteBtn).should('not.exist')
      cy.get(voteView).find(twitterVoteBtn).should('not.exist')
      cy.get(commentView).find(facebookCommentBtn).should('not.exist')
      cy.get(commentView).find(twitterCommentBtn).should('not.exist')
      cy.get('textarea#comment_form_textarea').type('This is a test comment')
      cy.get('button#comment_button').click()

      cy.wait('@postComment').its('response.statusCode').should('eq', 200)
      cy.contains('Statement submitted!').should('be.visible')
    })
  })
})
