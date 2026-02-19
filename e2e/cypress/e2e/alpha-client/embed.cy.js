/**
 * Alpha embed.js tests
 *
 * These tests validate the alpha embed script (`/alpha/embed.js`) in a host-page context.
 * They intentionally exercise a cross-context flow:
 *   host page -> alpha embed.js -> iframe pointing at /alpha/:conversation_id
 */

import {
  createTestConversation,
  addCommentToConversation,
} from '../../support/conversation-helpers.js'

const topic = 'Alpha Embedded Conversation Topic'
const description = 'Alpha Embedded Conversation Description'

describe('Alpha Embedded Conversations', function () {
  before(function () {
    cy.log('🚀 Setting up alpha embed test suite')

    createTestConversation({
      topic,
      description,
      userEmail: 'admin@polis.test',
      userPassword: 'Te$tP@ssw0rd*',
    }).then((conversationId) => {
      cy.wrap(conversationId).as('convoId')

      addCommentToConversation(conversationId, 'Seed comment for alpha embed test')
    })
  })

  it('builds embed HTML that loads /alpha/embed.js', function () {
    const embedUrl = 'http://localhost'

    cy.exec(`npm run build:embed:alpha -- --id=${this.convoId} --url=${embedUrl} --lang=en`).then(
      (result) => {
        expect(result.exitCode).to.equal(0)
        expect(result.stdout).to.contain(
          `Generated ./embed/alpha-index.html with Conversation ID ${this.convoId}`,
        )
      },
    )

    cy.readFile('./embed/alpha-index.html').then((content) => {
      expect(content).to.contain(`data-conversation_id="${this.convoId}"`)
      expect(content).to.contain(`src="${embedUrl}/alpha/embed.js"`)
      expect(content).to.contain('class="polis"')
    })
  })

  it('creates an iframe pointing at /alpha/:conversation_id with expected params', function () {
    const xid = `alpha-embed-xid-${Date.now()}`
    const embedUrl = 'http://localhost'
    const topicArg = JSON.stringify(topic)

    cy.exec(
      `npm run build:embed:alpha -- --id=${this.convoId} --url=${embedUrl} --lang=fr --xid=${xid} --topic=${topicArg} --authNeededToVote=true --authNeededToWrite=true`,
    )
      .its('exitCode')
      .should('eq', 0)

    cy.readFile('./embed/alpha-index.html').then((html) => {
      cy.intercept('GET', '/embedded-alpha', {
        statusCode: 200,
        body: html,
        headers: { 'Content-Type': 'text/html' },
      }).as('embedPage')
    })

    // Ensure embed.js targets localhost in local test environments, regardless of PUBLIC_EMBED_HOSTNAME.
    cy.intercept('GET', '/alpha/embed.js', (req) => {
      req.continue((res) => {
        if (typeof res.body === 'string') {
          res.body = res.body.replace(
            /const EMBED_SERVICE_HOSTNAME = "[^"]+";/,
            'const EMBED_SERVICE_HOSTNAME = "localhost";',
          )
        }
      })
    }).as('embedScript')

    cy.visit('/embedded-alpha')
    cy.wait('@embedPage')
    cy.wait('@embedScript')

    cy.get('iframe[data-testid="polis-iframe"]')
      .should('be.visible')
      .invoke('attr', 'src')
      .then((src) => {
        expect(src).to.contain(`/alpha/${this.convoId}`)

        const url = new URL(src)
        expect(url.searchParams.get('hide_header')).to.equal('true')
        expect(url.searchParams.get('parent_url')).to.exist
        // referrer can be empty string in Cypress, but it should exist
        expect(url.searchParams.has('referrer')).to.equal(true)

        // Custom params (URLSearchParams decodes + vs %20 differences)
        expect(url.searchParams.get('xid')).to.equal(xid)
        expect(url.searchParams.get('ui_lang')).to.equal('fr')
        expect(url.searchParams.get('topic')).to.equal(topic)
        expect(url.searchParams.get('auth_needed_to_vote')).to.equal('true')
        expect(url.searchParams.get('auth_needed_to_write')).to.equal('true')
      })
  })
})
