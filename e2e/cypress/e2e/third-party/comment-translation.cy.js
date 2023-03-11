describe('Comment translation', function () {
  const commentFrench = 'Cette déclaration est en français.'
  const commentEnglish = 'This statement is in French.'

  before(function () {
    cy.createConvo().then(() => {
      cy.seedComment(this.convoId, commentFrench)
    })
  })

  it('prevents translation when comment already in browser language', function () {
    cy.ensureUser()
    cy.openTranslated(this.convoId, 'fr')

    cy.contains('p', commentFrench).should('exist')
    cy.get('button#showTranslationButtonVoteView').should('not.exist')
  })

  it('allows translation when comment not in browser language', function () {
    cy.ensureUser()
    cy.openTranslated(this.convoId, 'en')

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
