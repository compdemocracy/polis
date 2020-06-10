describe('Interface internationalization', () => {
  let lang

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
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Danish', function () {
    lang = 'da'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into English', function () {
    lang = 'en'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Spanish', function () {
    lang = 'es'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into French', function () {
    lang = 'fr'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Italian', function () {
    lang = 'it'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Japanese', function () {
    lang = 'ja'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Dutch', function () {
    lang = 'nl'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Portugese', function () {
    lang = 'pt'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Simplified Chinese', function () {
    lang = 'zh-CN'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

  it('translates into Traditional Chinese', function () {
    lang = 'zh-TW'
    cy.visit(this.convoPath, {qs: {ui_lang: lang}})
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', this.strings[lang])
  })

})
