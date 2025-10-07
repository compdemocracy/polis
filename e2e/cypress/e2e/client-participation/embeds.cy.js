import {
  createTestConversation,
  addCommentToConversation,
} from '../../support/conversation-helpers.js'

const topic = 'Embedded Conversation Topic'
const description = 'Embedded Conversation Description'

describe('Embedded Conversations', function () {
  before(function () {
    cy.log('🚀 Setting up embedded conversation test suite')

    createTestConversation({
      topic,
      description,
      userEmail: 'admin@polis.test',
      userPassword: 'Te$tP@ssw0rd*',
    }).then((conversationId) => {
      cy.wrap(conversationId).as('convoId')

      // Add a seed comment to make the conversation more realistic
      addCommentToConversation(
        conversationId,
        'This is a test comment for the embedded conversation.',
      )
    })
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  describe('participation view parameters', function () {
    it('shows all UI elements by default', function () {
      // Visit the conversation directly with default settings
      cy.visit(`/${this.convoId}`)
      cy.wait('@participationInit')

      // Check all elements are visible
      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('[data-view-name="participationView"]').should('be.visible')
      cy.get('[data-view-name="vote-view"]').should('be.visible')
      cy.get('#helpTextWelcome').should('be.visible')
      cy.get('[data-view-name="comment-form"]').should('be.visible')
      cy.get('[data-test-footer]').should('be.visible')

      // Verify conversation content
      cy.get('.conversationViewHeadline h2').should('contain', topic)
      cy.get('.conversationViewHeadline p').should('contain', description)
    })

    it('hides voting when ucv=0', function () {
      cy.visit(`/${this.convoId}?ucv=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('[data-view-name="vote-view"]').should('not.be.visible')
    })

    it('hides commenting when ucw=0', function () {
      cy.visit(`/${this.convoId}?ucw=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('[data-view-name="comment-form"]').should('not.be.visible')
    })

    it('hides help text when ucsh=0', function () {
      cy.visit(`/${this.convoId}?ucsh=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('#helpTextWelcome').should('not.be.visible')
    })

    it('hides description when ucsd=0', function () {
      cy.visit(`/${this.convoId}?ucsd=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('.conversationViewHeadline h2').should('contain', topic)
      cy.get('.conversationViewHeadline p').should('not.exist')
    })

    it('hides footer when ucsf=0', function () {
      cy.visit(`/${this.convoId}?ucsf=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('[data-test-footer]').should('not.exist')
    })

    it('hides topic when ucst=0', function () {
      cy.visit(`/${this.convoId}?ucst=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('.conversationViewHeadline h2').should('not.exist')
    })

    it('hides vis when ucsv=0', function () {
      cy.visit(`/${this.convoId}?ucsv=0`)
      cy.wait('@participationInit')

      cy.get('[data-view-name="root"]').should('be.visible')
      cy.get('#vis_section').should('not.be.visible')
    })
  })

  describe('embed HTML generation', function () {
    it('generates correct embed HTML', function () {
      const embedUrl = 'http://localhost:8080'

      // Test that we can generate embed HTML with different configurations
      cy.exec(`npm run build:embed -- --id=${this.convoId} --url=${embedUrl}`).then((result) => {
        expect(result.exitCode).to.equal(0)
        expect(result.stdout).to.contain(
          `Generated ./embed/index.html with Conversation ID ${this.convoId}`,
        )
      })

      // Verify the generated file contains expected content
      cy.readFile('./embed/index.html').then((content) => {
        expect(content).to.contain(`data-conversation_id="${this.convoId}"`)
        expect(content).to.contain(`src="${embedUrl}/embed.js"`)
        expect(content).to.contain('class="polis"')
      })
    })

    it('generates embed HTML with custom parameters', function () {
      const embedUrl = 'http://localhost:8080'

      // Test with custom parameters
      cy.exec(
        `npm run build:embed -- --id=${this.convoId} --url=${embedUrl} --ucv=false --ucw=false --ucsf=false`,
      ).then((result) => {
        expect(result.exitCode).to.equal(0)
      })

      // Verify the generated file contains custom parameters
      cy.readFile('./embed/index.html').then((content) => {
        expect(content).to.contain('data-ucv="0"')
        expect(content).to.contain('data-ucw="0"')
        expect(content).to.contain('data-ucsf="0"')
      })
    })
  })
})
