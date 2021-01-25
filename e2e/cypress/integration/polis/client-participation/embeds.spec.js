describe('Embedded Conversations', () => {
  // This test requires overriding client-admin/embed.html with
  // e2e/cypress/fixtures/html/embeds.html
  const POLIS_DOMAIN = Cypress.config().baseUrl.replace('https://', '')

  beforeEach(function () {
    cy.createConvo('moderator').then(() => {
      cy.seedComment('Seed statement 1', this.convoId)
    })
  })

  it('renders a default embed', function () {
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&convoId=${this.convoId}`)
    cy.frameLoaded(`#polis_${this.convoId}`)
    cy.iframe(`#polis_${this.convoId}`).find('#agreeButton').should('be.visible')
  })

  // TODO: test each data-* attribute

  // TODO: test xid usage

  // TODO: test postMessage events

  // TODO: test integration (that creates new convos)
})
