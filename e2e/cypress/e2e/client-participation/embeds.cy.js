const topic = 'Embedded Conversation Topic'
const description = 'Embedded Conversation Description'

describe('Embedded Conversations', function () {
  before(function () {
    cy.createConvo(topic, description).then(() => {
      cy.seedComment(this.convoId)
    })
    cy.logout()
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  describe('default embed', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl}`)
      cy.interceptEmbed()
    })

    it('renders a default embed', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('[data-view-name="participationView"]')
        .should('be.visible')
        .find('[data-view-name="readReactView"]')
        .should('be.visible')
        .find('[data-view-name="vote-view"]')
        .should('be.visible')

      cy.getIframeBody().find('#helpTextWelcome').should('be.visible')
      cy.getIframeBody().find('[data-view-name="comment-form"]').should('be.visible')
      cy.getIframeBody().find('[data-view-name="profile-pic-view"]').should('be.visible')
      cy.getIframeBody().find('[data-test-footer]').should('be.visible')

      cy.getIframeBody()
        .find('.conversationViewHeadline')
        .find('h2')
        .should('contain', topic)
        .siblings('p')
        .should('contain', description)
    })
  })

  describe('user-can-vote (ucv) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucv=false`)
      cy.interceptEmbed()
    })

    it('hides voting', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('[data-view-name="vote-view"]')
        .should('not.be.visible')
    })
  })

  describe('user-can-write (ucw) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucw=false`)
      cy.interceptEmbed()
    })

    it('hides commenting', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('[data-view-name="comment-form"]')
        .should('not.be.visible')
    })
  })

  describe('user-can-see-help (ucsh) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucsh=false`)
      cy.interceptEmbed()
    })

    it('hides help text', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('#helpTextWelcome')
        .should('not.be.visible')
    })
  })

  describe('user-can-see-description (ucsd) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucsd=false`)
      cy.interceptEmbed()
    })

    it('hides description', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('.conversationViewHeadline')
        .find('h2')
        .should('contain', topic)
        .siblings('p')
        .should('not.exist')
    })
  })

  describe('user-can-see-footer (ucsf) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucsf=false`)
      cy.interceptEmbed()
    })

    it('hides footer', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .get('[data-test-footer]')
        .should('not.exist')
    })
  })

  describe('user-can-see-topic (ucst) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucst=false`)
      cy.interceptEmbed()
    })

    it('hides topic', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('.conversationViewHeadline h2')
        .should('not.exist')
    })
  })

  // TODO - add enough votes to show the vis
  describe('user-can-see-vis (ucsv) is OFF', function () {
    before(function () {
      const baseUrl = Cypress.config('baseUrl')
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${baseUrl} --ucsv=false`)
      cy.interceptEmbed()
    })

    it('hides vis', function () {
      cy.visit('/embedded')
      cy.wait('@participationInit')

      cy.getIframeBody()
        .find('[data-view-name="root"]')
        .should('be.visible')
        .find('#vis_section')
        .should('not.be.visible')
    })
  })
})
