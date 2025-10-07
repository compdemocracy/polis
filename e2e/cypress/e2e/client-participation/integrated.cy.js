import { faker } from '@faker-js/faker'
import { loginStandardUser } from '../../support/auth-helpers.js'

describe('Integrated Conversations', function () {
  before(function () {
    cy.log('🚀 Setting up integrated conversation test suite')

    // Login as admin to get site_id
    loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

    cy.visit('/integrate')

    // Wait for the site_id to actually load (not show "loading, try refreshing")
    cy.get('pre')
      .should('be.visible')
      .should('not.contain', 'loading, try refreshing')
      .invoke('text')
      .then((text) => {
        cy.log('📄 Integration page content:', text)
        const match = text.match(/data-site_id="(\w+)"/)
        if (!match || match.length < 2) {
          throw new Error(`Could not find site_id in integration page content: ${text}`)
        }
        const siteId = match[1]
        cy.wrap(siteId).as('siteId')
        cy.log(`📋 Got site ID: ${siteId}`)
      })
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  describe('site integration', function () {
    it('creates conversations for site and page IDs', function () {
      const pageId = faker.string.uuid()
      const parentUrl = 'http://localhost'

      // Visit site/page URL pattern with required parent_url parameter
      cy.visit(`/${this.siteId}/${pageId}?parent_url=${encodeURIComponent(parentUrl)}`)
      cy.wait('@participationInit')
        .its('response.body')
        .then((response) => {
          expect(response).to.have.property('conversation')
          const convoId = response.conversation.conversation_id
          cy.wrap(convoId).as('convoId')
          cy.log(`📝 Created conversation: ${convoId}`)
        })

      // Verify the conversation view loaded
      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('[data-view-name="participationView"]').should('be.visible')
    })

    it('reuses conversation for same page ID', function () {
      const pageId = faker.string.uuid()
      const parentUrl = 'http://localhost'

      // First visit - creates a new conversation
      cy.visit(`/${this.siteId}/${pageId}?parent_url=${encodeURIComponent(parentUrl)}`)
      cy.wait('@participationInit')
        .its('response.body')
        .then((firstResponse) => {
          expect(firstResponse).to.have.property('conversation')
          const firstConvoId = firstResponse.conversation.conversation_id
          cy.log(`📝 First visit conversation: ${firstConvoId}`)
          cy.wrap(firstConvoId).as('firstConvoId')
        })

      // Second visit with same page ID - should reuse existing conversation
      // The server redirects to existing conversation, so we need to check the URL
      cy.get('@firstConvoId').then((firstConvoId) => {
        cy.visit(`/${this.siteId}/${pageId}?parent_url=${encodeURIComponent(parentUrl)}`)

        // After redirect, check if we ended up on the same conversation
        cy.url().should('include', firstConvoId)

        // Verify the conversation loads properly
        cy.get('[data-view-name="root"]').should('be.visible')
        cy.get('[data-view-name="participationView"]').should('be.visible')

        cy.log(`📝 Second visit successfully reused conversation: ${firstConvoId}`)
      })
    })

    it('creates different conversations for different page IDs', function () {
      const pageId1 = faker.string.uuid()
      const pageId2 = faker.string.uuid()
      const parentUrl = 'http://localhost'

      // First page
      cy.visit(`/${this.siteId}/${pageId1}?parent_url=${encodeURIComponent(parentUrl)}`)
      cy.wait('@participationInit')
        .its('response.body.conversation.conversation_id')
        .then((convoId1) => {
          cy.log(`📝 Page 1 conversation: ${convoId1}`)

          // Second page
          cy.visit(`/${this.siteId}/${pageId2}?parent_url=${encodeURIComponent(parentUrl)}`)
          cy.wait('@participationInit')
            .its('response.body.conversation.conversation_id')
            .then((convoId2) => {
              cy.log(`📝 Page 2 conversation: ${convoId2}`)
              expect(convoId2).to.not.equal(convoId1)
            })
        })
    })

    it('created conversations have default properties', function () {
      const pageId = faker.string.uuid()
      const parentUrl = 'http://localhost'

      // Create a conversation
      cy.visit(`/${this.siteId}/${pageId}?parent_url=${encodeURIComponent(parentUrl)}`)
      cy.wait('@participationInit').its('response.body.conversation.conversation_id').as('convoId')

      // Login to check conversation properties
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      cy.get('@convoId').then((convoId) => {
        cy.visit('/m/' + convoId)
        cy.wait('@getConversations')
          .its('response.body')
          .then((responseBody) => {
            cy.log('📊 API response received:', responseBody)

            // Handle both single conversation object and array responses
            const conversation = Array.isArray(responseBody) ? responseBody[0] : responseBody

            cy.log('📊 Verifying conversation defaults')
            expect(conversation).to.have.property('topic', null)
            expect(conversation).to.have.property('description', null)
            expect(conversation).to.have.property('vis_type', 0)
            expect(conversation).to.have.property('write_type', 1)
            expect(conversation).to.have.property('help_type', 1)
            expect(conversation).to.have.property('subscribe_type', 1)
            expect(conversation).to.have.property('strict_moderation', false)
          })
      })
    })
  })

  describe('integrated HTML generation', function () {
    it('generates correct integrated HTML', function () {
      const pageId = faker.string.uuid()
      const embedUrl = 'http://localhost:8080'

      // Test that we can generate integrated HTML
      cy.exec(
        `npm run build:integrated -- --siteId=${this.siteId} --pageId=${pageId} --baseUrl=${embedUrl}`,
      ).then((result) => {
        expect(result.exitCode).to.equal(0)
        expect(result.stdout).to.contain(
          `Generated ./embed/integrated-index.html with Site ID ${this.siteId}`,
        )
      })

      // Verify the generated file contains expected content
      cy.readFile('./embed/integrated-index.html').then((content) => {
        expect(content).to.contain(`data-site_id="${this.siteId}"`)
        expect(content).to.contain(`data-page_id="${pageId}"`)
        expect(content).to.contain(`src="${embedUrl}/embed.js"`)
        expect(content).to.contain('class="polis"')
      })
    })

    it('shows the integration code on admin page', function () {
      loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

      cy.visit('/integrate')
      cy.get('pre')
        .should('be.visible')
        .and('contain', `data-site_id="${this.siteId}"`)
        .and('contain', 'class="polis"')
        .and('contain', 'embed.js')
    })
  })
})
