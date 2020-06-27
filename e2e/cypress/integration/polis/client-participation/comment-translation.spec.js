describe('Comment translation', () => {
  let browserLanguage
  const commentEnglish = 'This comment is written in English.'
  const commentFrench = 'Ce commentaire est écrit en anglais.'

  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]

      cy.createConvo(user.email, user.password)

      cy.route('POST', Cypress.config().apiPath + '/comments').as('newSeed')
      cy.get('textarea[maxlength="400"]').type(commentEnglish)

      // This button sometimes doesn't succeed. Can possibly fix if needed.
      // See: https://docs.cypress.io/guides/core-concepts/retry-ability.html#Why-are-some-commands-NOT-retried
      cy.contains('button', 'Submit').click()
      cy.wait('@newSeed').then((xhr) => {
        expect(xhr.status).to.equal(200)
      })

      cy.location('pathname').then((adminPath) => {
        const convoId = adminPath.replace('/m/', '')
        cy.wrap(convoId).as('convoId')
      })
    })
  })

  it("show button when comment not in browser language", function () {
    // Moderator will have implicitly voted on seed comment, so log out.
    cy.clearCookies()
    cy.reload()

    browserLanguage = 'fr'
    cy.visit(`/${this.convoId}`, {qs: {ui_lang: browserLanguage}})

    cy.contains('p', commentEnglish).should('exist')

    cy.get('button#showTranslationButtonVoteView').should('exist')
    cy.contains('p', commentFrench).should('not.exist')

    // Enable translations.
    cy.get('button#showTranslationButtonVoteView').click()
    cy.contains('p', commentFrench).should('exist')

    // Disable translations.
    cy.get('button#hideTranslationButtonVoteView').click()
    cy.contains('p', commentFrench).should('not.exist')
  })
})
