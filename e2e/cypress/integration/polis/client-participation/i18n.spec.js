describe('Interface internationalization', () => {
  let lang
  const strings = {
    da: 'Del dit perspektiv...',
    de: 'Teilen Sie Ihren Standpunkt mit ...',
    en: 'Share your perspective...',
    es: 'Compartir su perspectiva...',
    fr: 'Faites connaître votre point de vue...',
    it: 'Condividi il tuo punto di vista...',
    ja: 'あなたの考え方を共有しよう……',
    nl: 'Geef uw mening...',
    pt: 'Inclua seu comentário...',
    'zh-CN': '分享您的观点...',
    'zh-TW': '分享您的觀點...',
  }

  it('translates into German', function () {
    lang = 'de'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Danish', function () {
    lang = 'da'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into English', function () {
    lang = 'en'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Spanish', function () {
    lang = 'es'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into French', function () {
    lang = 'fr'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Italian', function () {
    lang = 'it'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Japanese', function () {
    lang = 'ja'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Dutch', function () {
    lang = 'nl'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Portugese', function () {
    lang = 'pt'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Simplified Chinese', function () {
    lang = 'zh-CN'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

  it('translates into Traditional Chinese', function () {
    lang = 'zh-TW'
    cy.visit(`/5s3sd6nhtv?ui_lang=${lang}`)
    cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', strings[lang])
  })

})
