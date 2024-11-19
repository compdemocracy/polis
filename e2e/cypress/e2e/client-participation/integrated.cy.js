import { faker } from '@faker-js/faker'

describe('Integrated Conversations', function () {
  before(function () {
    cy.ensureUser('moderator')
    cy.visit('/integrate')
    cy.get('pre')
      .invoke('text')
      .then((text) => {
        const [, siteId] = text.match(/data-site_id="(\w+)"/)
        cy.wrap(siteId).as('siteId')
      })
  })

  beforeEach(function () {
    const pageId = faker.datatype.uuid()
    cy.wrap(pageId).as('pageId')

    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
  })

  describe('default conversation', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')

      cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
      cy.exec(
        `npm run build:integrated -- --siteId=${this.siteId} --pageId=${this.pageId} --baseUrl=${baseUrl}`
      )
      cy.interceptIntegrated()
      cy.visit('/integrated')
      cy.wait('@participationInit')
        .its('request.query.conversation_id')
        .should('exist')
        .as('convoId')

      cy.getIframeBody().find('[data-view-name="root"]').should('be.visible')
    })

    it('is created with default properties', function () {
      cy.ensureUser('moderator')
      cy.visit('/m/' + this.convoId)
      // force reload to ensure we're not getting cached data
      cy.reload(true)
      cy.wait('@getConversations')
        .its('response.body')
        .then((conversation) => {
          expect(conversation).to.have.property('topic', null)
          expect(conversation).to.have.property('description', null)
          expect(conversation).to.have.property('vis_type', 0)
          expect(conversation).to.have.property('write_type', 1)
          expect(conversation).to.have.property('help_type', 1)
          expect(conversation).to.have.property('subscribe_type', 1)
          expect(conversation).to.have.property('auth_opt_fb', null)
          expect(conversation).to.have.property('auth_opt_tw', null)
          expect(conversation).to.have.property('strict_moderation', false)
          expect(conversation).to.have.property('auth_needed_to_write', null)
          expect(conversation).to.have.property('auth_needed_to_vote', null)
        })
    })

    it('shows the integration url on its /share page', function () {
      cy.ensureUser('moderator')
      cy.visit('/m/' + this.convoId + '/share')
      cy.get('[data-test-id="embed-page"]')
        .should('be.visible')
        .and('contain', Cypress.config('baseUrl') + '/integrated')
    })

    it('shows the integration url on the admin home page', function () {
      cy.ensureUser('moderator')
      cy.visit('/')
      cy.get('[data-test-id="embed-page"]')
        .contains(Cypress.config('baseUrl') + '/integrated')
        .should('be.visible')
    })
  })
})
