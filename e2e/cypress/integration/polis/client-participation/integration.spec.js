describe('Integrated Conversations', () => {
  // This test requires overriding client-admin/embed.html with
  // e2e/cypress/fixtures/html/embeds.html
  const POLIS_DOMAIN = Cypress.config().baseUrl.replace('https://', '')
  const CONVO_DESCRIPTION = 'This is dummy description for embed tests.'
  const CONVO_TOPIC = 'Integration test topic'
  const CONVO_DEFAULTS = {
    topic: null,
    description: null,

    vis_type: 0,
    write_type: 1,
    help_type: 1,
    subscribe_type: 1,
    auth_opt_fb: null,
    auth_opt_tw: null,

    strict_moderation: false,
    auth_needed_to_write: null,
    auth_needed_to_vote: null,
  }

  before(function () {
    cy.login('moderator')
    cy.visit('/integrate')
    cy.get('pre').invoke('text').then((snippet) => {
      const reSiteId = /'(polis_site_id_[a-zA-Z0-9]+)'/gm
      const match = reSiteId.exec(snippet)
      cy.wrap(match[1]).as('siteId')
    })
  })

  beforeEach(function () {
    // xip.io is maybe throttling these fast tests.
    cy.wait(500)
  })

  it('creates a convo with defaults', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        for (const [field, val] of Object.entries(CONVO_DEFAULTS)) {
          cy.wrap(mostRecentConvo).its(field).should('equal', val)
        }
        cy.wrap(mostRecentConvo).its('parent_url').should('equal', integrationUrl)

        // Ensure integration url also showing in UI locations.
        cy.visit(`/m/${mostRecentConvo.conversation_id}/share`)
        cy.get('*[data-test-id="embed-page"]').should('contain', integrationUrl)
        cy.visit('/')
        cy.get('*[data-test-id="embed-page"]').first().should('contain', integrationUrl)
      })
  })

  it('creates a convo with topic', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-topic=${CONVO_TOPIC}`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('topic').should('equal', CONVO_TOPIC)
      })
  })

  // Feature doesn't yet exist yet.
  // See: https://github.com/pol-is/polis/issues/315
  it.skip('creates a convo with description', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-topic=${CONVO_DESCRIPTION}`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('description').should('equal', CONVO_DESCRIPTION)
      })
  })

  it('creates a convo with vis enabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-show_vis=true`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('vis_type').should('equal', 1)
      })
  })

  // Not working
  it.skip('creates a convo with top comments style vis', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-vis_type=2`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('vis_type').should('equal', 2)
      })
  })

  it.skip('creates a convo with commenting disabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-write_type=0`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('write_type').should('equal', 0)
      })
  })

  // Doesn't seem to work right now.
  it.skip('creates a convo with help disabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-help_type=0`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('help_type').should('equal', 0)
      })
  })

  // Doesn't seem to work right now.
  it.skip('creates a convo with new comment subscriptions disabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-subscribe_type=0`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('subscribe_type').should('equal', 0)
      })
  })

  it('creates a convo with login required to vote', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-auth_needed_to_vote=true`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('auth_needed_to_vote').should('equal', true)
      })
  })

  it('creates a convo with login required to comment', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-auth_needed_to_write=true`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('auth_needed_to_write').should('equal', true)
      })
  })

  it('creates a convo with facebook login button enabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-auth_opt_fb=true`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('auth_opt_fb').should('equal', true)
      })
  })

  it('creates a convo with twitter login button enabled', function () {
    cy.logout()
    const pageId = Math.floor(Date.now() / 1000)
    const integrationUrl = `${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-page_id=${pageId}&data-site_id=${this.siteId}&data-auth_opt_tw=true`
    cy.visit(integrationUrl)
    cy.enter(`#polis_${this.siteId}_${pageId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })

    cy.login('moderator')
    cy.request('GET', Cypress.config().apiPath + '/conversations?include_all_conversations_i_am_in=true')
      .then(resp => {
        const mostRecentConvo = resp.body.shift()
        cy.wrap(mostRecentConvo).its('auth_opt_tw').should('equal', true)
      })
  })

  // deprecated data-* params:
  //   - data-show_share - bool. sets socialbtn_type from 0 to 1. not in ui. no apparent effect.
  //   - data-auth_opt_allow_3rdparty - bool. no apparent effect.
  //   - data-dwok. (domain whitelist override key) unsure.
  //   - data-bg_white - bool. toggles bgcolor db value, but no effect in ui.
})
