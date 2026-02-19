/**
 * Alpha client interface i18n tests (static UI strings only)
 *
 * Notes:
 * - We do NOT test statement translation (depends on external translation API).
 * - Alpha is SSR + React islands; we assert text rendered from `s` (translations)
 *   using `ui_lang` query param and Accept-Language header.
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

function assertStaticStrings({ agree, disagree, pass, privacy, tos }) {
  cy.get('[data-testid="vote-agree"]').should('contain.text', agree)
  cy.get('[data-testid="vote-disagree"]').should('contain.text', disagree)
  cy.get('[data-testid="vote-pass"]').should('contain.text', pass)

  cy.get('a[href="/privacy"]').should('contain.text', privacy)
  cy.get('a[href="/tos"]').should('contain.text', tos)
}

describe('Alpha Client: Interface internationalization (i18n)', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'I18n Test Conversation (alpha)',
      description: 'Testing interface translations in alpha client',
      comments: ['Seed comment (not testing statement translation)'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  beforeEach(function () {
    cy.clearAllLocalStorage()
  })

  it('uses ui_lang query param (fr)', function () {
    cy.visit(`/alpha/${conversationId}?ui_lang=fr`)
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'fr')
    cy.get('html').should('have.attr', 'dir', 'ltr')

    assertStaticStrings({
      agree: 'En accord',
      disagree: 'En désaccord',
      pass: 'Neutre / Incertain',
      privacy: 'Avis de confidentialité',
      tos: 'Conditions du service',
    })
  })

  it('uses Accept-Language header when ui_lang is absent (fr-FR)', function () {
    cy.visit(`/alpha/${conversationId}`, {
      headers: {
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    })
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'fr-FR')
    cy.get('html').should('have.attr', 'dir', 'ltr')

    assertStaticStrings({
      agree: 'En accord',
      disagree: 'En désaccord',
      pass: 'Neutre / Incertain',
      privacy: 'Avis de confidentialité',
      tos: 'Conditions du service',
    })
  })

  it('normalizes region locales (pt-BR)', function () {
    cy.visit(`/alpha/${conversationId}?ui_lang=pt-BR`)
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'pt-BR')
    cy.get('html').should('have.attr', 'dir', 'ltr')

    assertStaticStrings({
      agree: 'Concordo',
      disagree: 'Discordo',
      pass: 'Passo / Indeciso',
      privacy: 'Privacidade',
      tos: 'Termos de uso',
    })
  })

  it('maps zh-CN to Simplified Chinese strings', function () {
    cy.visit(`/alpha/${conversationId}?ui_lang=zh-CN`)
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'zh-CN')
    cy.get('html').should('have.attr', 'dir', 'ltr')

    assertStaticStrings({
      agree: '赞成',
      disagree: '反对',
      pass: '略过 / 不确定',
      privacy: '隐私',
      tos: '使用条款',
    })
  })

  it('supports rtl-script locales (fa) for static strings', function () {
    cy.visit(`/alpha/${conversationId}?ui_lang=fa`)
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'fa')
    cy.get('html').should('have.attr', 'dir', 'rtl')

    assertStaticStrings({
      agree: 'موافق',
      disagree: 'مخالف',
      pass: 'رد کن/مطمئن نیستم',
      privacy: 'سیاست حفظ حریم خصوصی',
      tos: 'شرایط استفاده از خدمات',
    })
  })

  it('ui_lang query param overrides Accept-Language header', function () {
    // Force a mismatch: header requests French, query requests zh-CN.
    cy.visit(`/alpha/${conversationId}?ui_lang=zh-CN`, {
      headers: {
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
    })
    cy.get('[data-testid="vote-agree"]').should('be.visible')

    cy.get('html').should('have.attr', 'lang', 'zh-CN')
    cy.get('html').should('have.attr', 'dir', 'ltr')

    assertStaticStrings({
      agree: '赞成',
      disagree: '反对',
      pass: '略过 / 不确定',
      privacy: '隐私',
      tos: '使用条款',
    })
  })
})
