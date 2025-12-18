/**
 * Alpha integrated embed tests (first iteration)
 *
 * The legacy embed.js supports integrated site_id/page_id embeds.
 * The alpha embed.js implementation currently only supports data-conversation_id.
 *
 * For now, we validate HTML generation only (keeps alpha suite green), and leave a
 * skipped test as a parity target for future implementation.
 */

import { faker } from '@faker-js/faker'
import { loginStandardUser } from '../../support/auth-helpers.js'

describe('Alpha Integrated Conversations (embed.js parity target)', function () {
  before(function () {
    // Login as admin to get site_id (legacy integrate page)
    loginStandardUser('admin@polis.test', 'Te$tP@ssw0rd*')

    cy.visit('/integrate')

    cy.get('pre')
      .should('be.visible')
      .should('not.contain', 'loading, try refreshing')
      .invoke('text')
      .then((text) => {
        const match = text.match(/data-site_id="(\w+)"/)
        if (!match || match.length < 2) {
          throw new Error(`Could not find site_id in integration page content: ${text}`)
        }
        cy.wrap(match[1]).as('siteId')
      })
  })

  it('generates integrated HTML pointing at /alpha/embed.js', function () {
    const pageId = faker.string.uuid()
    const embedUrl = 'http://localhost'

    cy.exec(
      `npm run build:integrated:alpha -- --siteId=${this.siteId} --pageId=${pageId} --baseUrl=${embedUrl}`,
    ).then((result) => {
      expect(result.exitCode).to.equal(0)
      expect(result.stdout).to.contain(
        `Generated ./embed/alpha-integrated-index.html with Site ID ${this.siteId}`,
      )
    })

    cy.readFile('./embed/alpha-integrated-index.html').then((content) => {
      expect(content).to.contain(`data-site_id="${this.siteId}"`)
      expect(content).to.contain(`data-page_id="${pageId}"`)
      expect(content).to.contain(`src="${embedUrl}/alpha/embed.js"`)
      expect(content).to.contain('class="polis"')
    })
  })

  it.skip('TODO: alpha embed.js supports data-site_id/data-page_id and creates iframe', function () {
    // Future parity test:
    // - serve generated alpha-integrated-index.html at /integrated-alpha
    // - visit /integrated-alpha
    // - assert iframe exists and points at /:siteId/:pageId or redirects to /alpha/:conversation_id
  })
})
