describe('Interface internationalization', () => {
  const openTranslated = (path, lang, string) => {
    cy.visit(path, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', string)
  }

  before(function () {
    cy.createConvo('moderator').then(() => {
      cy.wrap(`/${this.convoId}`).as('convoPath')
    })
  })

  beforeEach(() => {
    cy.fixture('writePrompt_strings.json').as('strings')
  })

  it('translates into Danish', function () {
    const lang = 'da'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into German', function () {
    const lang = 'de'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into English', function () {
    const lang = 'en'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Spanish', function () {
    const lang = 'es'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into French', function () {
    const lang = 'fr'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Italian', function () {
    const lang = 'it'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Japanese', function () {
    const lang = 'ja'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Dutch', function () {
    const lang = 'nl'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Portugese', function () {
    const lang = 'pt'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Simplified Chinese', function () {
    const lang = 'zh-CN'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Traditional Chinese', function () {
    const lang = 'zh-TW'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })
})
