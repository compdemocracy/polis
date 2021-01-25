describe('Embedded Conversations', () => {
  // This test requires overriding client-admin/embed.html with
  // e2e/cypress/fixtures/html/embeds.html
  const POLIS_DOMAIN = Cypress.config().baseUrl.replace('https://', '')
  const CONVO_DESCRIPTION = 'This is dummy description for embed tests.'
  const CONVO_TOPIC = 'Embed test topic'

  beforeEach(function () {
    cy.createConvo('moderator').then(() => {
      cy.seedComment('Seed statement 1', this.convoId)
      cy.get('[data-test-id="description"]').type(CONVO_DESCRIPTION).blur()
      cy.get('[data-test-id="topic"]').type(CONVO_TOPIC).blur()
    })
  })

  it('renders a default embed', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('#readReactView').as('vote-widget')
      cyframe().find('#comment_form_textarea').as('comment-widget')
      cyframe().find('#helpTextWelcome').as('vote-help')
      cyframe().find('.POLIS_HEADLINE').as('headline')
      cyframe().find('svg.svgCenter').as('footer-logo')
      cyframe().find('#vis_section').as('vis')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@vote-widget').should('be.visible')
    cy.get('@comment-widget').should('be.visible')
    cy.get('@vote-help').should('be.visible')
    cy.get('@headline').should('contain', CONVO_DESCRIPTION)
    cy.get('@footer-logo').should('be.visible')
    cy.get('@headline').should('contain', CONVO_TOPIC)
    // TODO add full votes to check this
    //cy.get('@vis').should('be.visible')
  })

  it('hides voting when user-can-vote (ucv) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucv=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('#readReactView').as('vote-widget')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@vote-widget').should('not.be.visible')
  })

  it('hides commenting when user-can-write (ucw) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucw=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('#comment_form_textarea').as('comment-widget')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@comment-widget').should('not.be.visible')
  })

  it('hides help text when user-can-see-help (ucsh) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucsh=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('#helpTextWelcome').as('vote-help')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@vote-help').should('not.be.visible')
  })

  it('hides description when user-can-see-description (ucsd) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucsd=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('.POLIS_HEADLINE').as('headline')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@headline').should('not.contain', CONVO_DESCRIPTION)
  })

  // Seems convo owner needs special permission to disable branding.
  it.skip('hides footer when user-can-see-footer (ucsf) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucsf=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('svg.svgCenter').as('footer-logo')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@footer-logo').should('not.be.visible')
  })

  it('hides vis when user-can-see-vis (ucsv) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucsv=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('#vis_section').as('vis')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@vis').should('not.be.visible')
  })

  it('hides topic when user-can-see-topic (ucst) is OFF', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&data-ucst=false`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cyframe().find('.POLIS_HEADLINE').as('headline')
    })

    cy.get('@iframe').should('be.visible')
    cy.get('@headline').should('not.contain', CONVO_TOPIC)
  })
  // TODO: test other data-* params
  //   - data-x_name
  //   - data-x_profile_image_url
  // See: https://roamresearch.com/#/app/polis-methods/page/hwRb6tXIA

  // This is currently broken and has a pending PR to fix.
  // TODO fix
  it.skip('creates xid when provided', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })
    cy.task('dbQuery', {
      sql: `
      `,
      values: [
      ],
    })
  })

  it.skip('does not create xid when not provided', function () {
    cy.logout()
    cy.visit(`${Cypress.config().baseUrl}/embed.html?polisDomain=${POLIS_DOMAIN}&data-conversation_id=${this.convoId}&xid=foobar`)
    cy.enter(`#polis_${this.convoId}`).then(cyframe => {
      cyframe().find('div[data-view-name="root"]').as('iframe')
      cy.get('@iframe').should('be.visible')
    })
  })

  // TODO: test postMessage events

  // TODO: test integration (that creates new convos), and related data-* params:
  //   - data-subscribe_type
  //   - data-show_share
  //   - data-auth_needed_to_vote
  //   - data-auth_needed_to_write
  //   - data-auth_opt_fb
  //   - data-auth_opt_tw
  //   - data-auth_opt_allow_3rdparty
  //   - data-dwok
  //   - data-topic
  //   - data-bg_white
})
