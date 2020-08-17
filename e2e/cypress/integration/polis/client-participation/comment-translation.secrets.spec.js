describe('Comment translation', () => {
  let browserLanguage
  const commentFrench = 'Cette déclaration est en français.'
  const commentEnglish = 'This statement is in French.'

  before(() => {
    cy.createConvo('moderator').then(() => {
      cy.seedComment(commentFrench, this.convoId)
    })

    // Moderator will have implicitly voted on seed comment, so log out.
    // See: https://github.com/pol-is/polisServer/issues/373
    cy.logout()
  })

  it("prevents translation when comment already in browser language", function () {
    browserLanguage = 'fr'
    cy.visit(`/${this.convoId}`, {qs: {ui_lang: browserLanguage}})

    cy.contains('p', commentFrench).should('exist')
    cy.get('button#showTranslationButtonVoteView').should('not.exist')
  })

  it("allows translation when comment not in browser language", function () {
    browserLanguage = 'en'
    cy.visit(`/${this.convoId}`, {qs: {ui_lang: browserLanguage}})

    cy.contains('p', commentFrench).should('exist')

    cy.get('button#showTranslationButtonVoteView').should('exist')
    cy.contains('p', commentEnglish).should('not.exist')

    // Enable translations.
    cy.get('button#showTranslationButtonVoteView').click()
    cy.contains('p', commentEnglish).should('exist')

    // Disable translations.
    cy.get('button#hideTranslationButtonVoteView').click()
    cy.contains('p', commentEnglish).should('not.exist')
  })
})
