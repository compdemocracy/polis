describe('Interface internationalization', () => {
  let lang

  const openTranslated = (path, lang, string) => {
    cy.visit(path, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', string)
  }

  before(() => {
    cy.fixture('users.json').then((users) => {
      const user = users[0]
      cy.createConvo(user.email, user.password)
      cy.url('pathname').then((adminPath) => {
        const convoPath = adminPath.replace('/m/', '/')
        cy.wrap(convoPath).as('convoPath')
      })
    })
  })

  beforeEach(() => {
    cy.fixture('writePrompt_strings.json').as('strings')
  })

  it('translates into German', function () {
    lang = 'de'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Danish', function () {
    lang = 'da'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into English', function () {
    lang = 'en'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Spanish', function () {
    lang = 'es'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into French', function () {
    lang = 'fr'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Italian', function () {
    lang = 'it'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Japanese', function () {
    lang = 'ja'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Dutch', function () {
    lang = 'nl'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Portugese', function () {
    lang = 'pt'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Simplified Chinese', function () {
    lang = 'zh-CN'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })

  it('translates into Traditional Chinese', function () {
    lang = 'zh-TW'
    openTranslated(this.convoPath, lang, this.strings[lang])
  })
})
