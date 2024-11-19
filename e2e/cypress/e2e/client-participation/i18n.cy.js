import { readTranslation } from '../../support/helpers'

function checkTranslation(lang, convoId) {
  cy.openTranslated(convoId, lang)
  readTranslation(lang).then((translation) => {
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', translation)
  })
}

describe('Interface internationalization', function () {
  before(function () {
    cy.ensureConversation()
  })

  it('translates into Arabic', function () {
    checkTranslation('ar', this.convoId)
  })

  it('translates into Welsh', function () {
    checkTranslation('cy', this.convoId)
  })

  it('translates into Danish', function () {
    checkTranslation('da', this.convoId)
  })

  it('translates into German', function () {
    checkTranslation('de', this.convoId)
  })

  it('translates into Greek', function () {
    checkTranslation('el', this.convoId)
  })

  it('translates into English', function () {
    checkTranslation('en', this.convoId)
  })

  it('translates into Spanish', function () {
    checkTranslation('es', this.convoId)
  })

  it('translates into Farsi', function () {
    checkTranslation('fa', this.convoId)
  })

  it('translates into French', function () {
    checkTranslation('fr', this.convoId)
  })

  it('translates into Frisian', function () {
    checkTranslation('fy', this.convoId)
  })

  it('translates into Hebrew', function () {
    checkTranslation('he', this.convoId)
  })

  it('translates into Croatian', function () {
    checkTranslation('hr', this.convoId)
  })

  it('translates into Italian', function () {
    checkTranslation('it', this.convoId)
  })

  it('translates into Japanese', function () {
    checkTranslation('ja', this.convoId)
  })

  it('translates into Dutch', function () {
    checkTranslation('nl', this.convoId)
  })

  it('translates into Portuguese', function () {
    checkTranslation('pt', this.convoId)
  })

  it('translates into Romanian', function () {
    checkTranslation('ro', this.convoId)
  })

  it('translates into Russian', function () {
    checkTranslation('ru', this.convoId)
  })

  it('translates into Slovak', function () {
    checkTranslation('sk', this.convoId)
  })

  it('translates into Tamil', function () {
    checkTranslation('ta', this.convoId)
  })

  it('translates into Tetum', function () {
    checkTranslation('tdt', this.convoId)
  })

  it('translates into Ukrainian', function () {
    checkTranslation('uk', this.convoId)
  })

  // zh-CN
  it('translates into Chinese', function () {
    checkTranslation('zh-CN', this.convoId)
  })

  // zh-TW
  it('translates into Chinese (Traditional)', function () {
    checkTranslation('zh-TW', this.convoId)
  })
})
