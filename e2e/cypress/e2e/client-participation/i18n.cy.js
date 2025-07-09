/**
 * Interface internationalization tests
 * Verifies that the UI is properly translated into supported languages
 */

import {
  setupTestConversation,
  openTranslated,
  readTranslation,
} from '../../support/conversation-helpers.js'

describe('Interface internationalization', function () {
  let conversationId

  before(function () {
    // Setup: Create a conversation for i18n testing
    cy.log('🚀 Setting up test conversation for i18n testing')

    setupTestConversation({
      topic: 'I18n Test Conversation',
      description: 'Testing interface translations across multiple languages',
      comments: ['Test comment for i18n'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  /**
   * Helper to check translation for a specific language
   * @param {string} lang - Language code
   * @param {string} convoId - Conversation ID
   */
  function checkTranslation(lang, convoId) {
    cy.log(`🌐 Checking translation for language: ${lang}`)

    openTranslated(convoId, lang)

    readTranslation(lang).then((translation) => {
      // The translation should appear as the placeholder text in the comment form
      cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', translation)
      cy.log(`✅ Translation verified for ${lang}: "${translation}"`)
    })
  }

  // Test each supported language
  it('translates into Arabic', function () {
    checkTranslation('ar', conversationId)
  })

  it('translates into Bosnian', function () {
    checkTranslation('bs', conversationId)
  })

  it('translates into Croatian', function () {
    checkTranslation('hr', conversationId)
  })

  it('translates into Welsh', function () {
    checkTranslation('cy', conversationId)
  })

  it('translates into Danish', function () {
    checkTranslation('da', conversationId)
  })

  it('translates into German', function () {
    checkTranslation('de', conversationId)
  })

  it('translates into Greek', function () {
    checkTranslation('el', conversationId)
  })

  it('translates into Burmese', function () {
    checkTranslation('my', conversationId)
  })

  it('translates into English', function () {
    checkTranslation('en', conversationId)
  })

  it('translates into Pashto', function () {
    checkTranslation('ps', conversationId)
  })

  it('translates into Spanish', function () {
    checkTranslation('es', conversationId)
  })

  it('translates into Swahili', function () {
    checkTranslation('sw', conversationId)
  })

  it('translates into Farsi', function () {
    checkTranslation('fa', conversationId)
  })

  it('translates into French', function () {
    checkTranslation('fr', conversationId)
  })

  it('translates into Frisian', function () {
    checkTranslation('fy', conversationId)
  })

  it('translates into Hebrew', function () {
    checkTranslation('he', conversationId)
  })

  it('translates into Italian', function () {
    checkTranslation('it', conversationId)
  })

  it('translates into Japanese', function () {
    checkTranslation('ja', conversationId)
  })

  it('translates into Dutch', function () {
    checkTranslation('nl', conversationId)
  })

  it('translates into Portuguese', function () {
    checkTranslation('pt', conversationId)
  })

  it('translates into Romanian', function () {
    checkTranslation('ro', conversationId)
  })

  it('translates into Russian', function () {
    checkTranslation('ru', conversationId)
  })

  it('translates into Slovak', function () {
    checkTranslation('sk', conversationId)
  })

  it('translates into Tamil', function () {
    checkTranslation('ta', conversationId)
  })

  it('translates into Tetum', function () {
    checkTranslation('tdt', conversationId)
  })

  it('translates into Ukrainian', function () {
    checkTranslation('uk', conversationId)
  })

  // zh-CN
  it('translates into Chinese', function () {
    checkTranslation('zh-CN', conversationId)
  })

  // zh-TW
  it('translates into Chinese (Traditional)', function () {
    checkTranslation('zh-TW', conversationId)
  })

  it('translates into Vietnamese', function () {
    checkTranslation('vi', conversationId)
  })

  // Test translation switching
  it('can switch between languages dynamically', function () {
    cy.log('🔄 Testing dynamic language switching')

    // Start in English
    openTranslated(conversationId, 'en')
    readTranslation('en').then((enTranslation) => {
      cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', enTranslation)
    })

    // Switch to Spanish
    openTranslated(conversationId, 'es')
    readTranslation('es').then((esTranslation) => {
      cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', esTranslation)
    })

    // Switch to French
    openTranslated(conversationId, 'fr')
    readTranslation('fr').then((frTranslation) => {
      cy.get('textarea#comment_form_textarea').should('have.attr', 'placeholder', frTranslation)
    })

    cy.log('✅ Dynamic language switching verified')
  })
})
