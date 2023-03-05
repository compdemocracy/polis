describe('Interface internationalization', function () {
  before(function () {
    cy.createConvo()
  })

  it('translates into Danish', function () {
    cy.openTranslated(this.convoId, 'da')
    cy.get('textarea#comment_form_textarea').should(
      'have.attr',
      'placeholder',
      'Del dit perspektiv...'
    )
  })
})
