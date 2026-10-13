import {
  addCommentsToConversation,
  createTestConversationAPI,
} from '../../support/conversation-helpers.js'
import { getAuthToken, logout } from '../../support/auth-helpers.js'

// Every client must work with no host but our own reachable: no code, style,
// font, image or frame may come from a third-party host at runtime. Each test
// blocks every non-local request, then loads real pages and fails on
//   - any blocked request to a host not listed below,
//   - any page error (uncaught exception), and
//   - any of our own scripts, styles, fonts or images failing to load.
//
// Deliberate third parties, listed by name until the project rules on them.
// They are blocked here like everything else; only the assertion allows them.
const DELIBERATE_HOSTS = [
  'scripts.simpleanalyticscdn.com', // Simple Analytics script (report, admin, participation)
  'queue.simpleanalyticscdn.com', // Simple Analytics beacons
]
// Not visited here because they frame a third party on purpose: /donate
// (donation form) and /home2 (a hosted topic-map demo).

// The standard report plus every topic, narrative and collective statement
// view the server routes to the report client.
const REPORT_ROUTES = [
  'report',
  'narrativeReport',
  'commentsReport',
  'topicReport',
  'topicsVizReport',
  'topicHierarchy',
  'topicMapNarrativeReport',
  'topicStats',
  'collectiveStatements',
  'exportReport',
]
const SIGNED_OUT_ADMIN_PAGES = ['/home', '/signin', '/tos', '/privacy']
const CONVERSATION_ADMIN_SECTIONS = ['comments', 'participants', 'reports', 'stats', 'share']

const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?`
const NON_LOCAL_URL = new RegExp(String.raw`^(?!https?://${LOCAL_HOST}/)[a-z][a-z0-9+.-]*://`, 'i')
const LOCAL_ASSET_URL = new RegExp(
  String.raw`^https?://${LOCAL_HOST}/[^?#]*\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf)(?:[?#].*)?$`,
  'i',
)

// What the pages read from the libraries they used to fetch from CDNs: the
// same versions those CDN links served, now from our own build.
function expectReportGlobals() {
  cy.window().its('d3.version').should('equal', '4.13.0')
  cy.window().its('d3.interpolateYlGnBu').should('be.a', 'function') // d3-scale-chromatic 1.5.0
  cy.window().its('Plotly.version').should('equal', '2.27.0')
}

function expectFontLoaded(family) {
  cy.document()
    .then((doc) => doc.fonts.ready)
    .then((fonts) => {
      const loaded = Array.from(fonts).filter(
        (face) => face.family.replace(/["']/g, '') === family && face.status === 'loaded',
      )
      expect(loaded.length, `${family} faces loaded`).to.be.greaterThan(0)
    })
}

function expectEmojiImage(alt) {
  cy.get(`img[alt="${alt}"]`, { timeout: 20000 })
    .first()
    .should(($img) => {
      expect($img.attr('src')).to.match(/^\/twemoji\//)
      expect($img[0].naturalWidth, `${alt} image decoded`).to.be.greaterThan(0)
    })
}

const PASSWORD = 'Te$tP@ssw0rd*'
const ADMIN = 'admin@polis.test'

// A page error this check knows about and that has nothing to do with
// third-party hosts: the alpha client's server-rendered page does not match
// its first client render (React reports a recoverable hydration error,
// #418), with or without the network.
const ALPHA_HYDRATION_MISMATCH = /Minified React error #418\b/

function expectSelfContained(seen, page, knownError = null) {
  // Late requests (fonts, emoji images, async scripts) fire after first render.
  cy.wait(2000)
  cy.then(() => {
    const thirdParty = seen.blocked.filter(
      (url) => !DELIBERATE_HOSTS.includes(new URL(url).hostname),
    )
    const errors = seen.errors.filter((message) => !(knownError && knownError.test(message)))
    if (errors.length < seen.errors.length) {
      cy.task('log', `${page}: known page error seen and allowed: ${knownError}`)
    }
    expect(thirdParty, `${page}: requests to third-party hosts`).to.deep.equal([])
    expect(seen.failedAssets, `${page}: our own assets that failed to load`).to.deep.equal([])
    expect(errors, `${page}: page errors`).to.deep.equal([])
  })
}

// A response served from the browser cache never reaches the network, so a
// file fetched from a third-party host earlier in the run (by another spec,
// or by this one's setup) would load here unseen. Clear the cache and keep it
// off for every request this spec makes.
function disableBrowserCache() {
  expect(Cypress.browser.family, 'this check drives the browser cache over CDP').to.equal('chromium')
  const cdp = (command, params = {}) =>
    cy.wrap(Cypress.automation('remote:debugger:protocol', { command, params }), { log: false })
  cdp('Network.enable')
  cdp('Network.clearBrowserCache')
  cdp('Network.setCacheDisabled', { cacheDisabled: true })
}

describe('Clients load nothing from third-party hosts', () => {
  let conversationId
  let reportId
  let seen

  function guardNetwork() {
    seen = { blocked: [], errors: [], failedAssets: [] }
    disableBrowserCache()
    cy.intercept({ url: NON_LOCAL_URL }, (req) => {
      seen.blocked.push(req.url)
      req.destroy()
    })
    // Observe only: a navigation may cancel an asset request mid-flight.
    cy.intercept({ url: LOCAL_ASSET_URL }, (req) => {
      req.on('after:response', (res) => {
        if (res.statusCode >= 400) seen.failedAssets.push(`${res.statusCode} ${req.url}`)
      })
    })
    cy.on('uncaught:exception', (err) => {
      seen.errors.push(err.message)
      return false
    })
  }

  before(() => {
    // The setup visits pages too: nothing may reach a third-party host here either.
    guardNetwork()
    cy.loginStandardUserAPI(ADMIN, PASSWORD).then(() =>
      createTestConversationAPI({
        topic: `Self-contained check ${Date.now()}`,
        description: 'Pages must render with every third-party host blocked',
      })
        .then((id) => {
          conversationId = id
          return addCommentsToConversation(
            conversationId,
            [
              'Public libraries should open on Sundays',
              'Bus lanes make the city better for everyone',
              'The park needs more shade trees',
            ],
            ADMIN,
            PASSWORD,
          )
        })
        .then(() => getAuthToken())
        .then((token) =>
          cy
            .request({
              method: 'POST',
              url: '/api/v3/reports',
              headers: { Authorization: `Bearer ${token}` },
              body: { conversation_id: conversationId },
            })
            .then(() =>
              cy.request({
                url: `/api/v3/reports?conversation_id=${conversationId}`,
                headers: { Authorization: `Bearer ${token}` },
              }),
            )
            .then((response) => {
              reportId = response.body[0].report_id
            }),
        ),
    )
  })

  beforeEach(() => guardNetwork())

  describe('report', () => {
    beforeEach(() => logout())

    for (const route of REPORT_ROUTES) {

      it(`/${route}/:report_id`, () => {
        cy.visit(`/${route}/${reportId}`)
        cy.get('#root').children().should('have.length.greaterThan', 0)
        expectSelfContained(seen, `/${route}`)
        expectReportGlobals()
      })
    }
  })

  describe('participation', () => {
    beforeEach(() => logout())

    it('legacy client: /:conversation_id', () => {
      cy.visit(`/${conversationId}`)
      cy.get('#agreeButton', { timeout: 20000 }).should('be.visible')
      expectSelfContained(seen, 'legacy participation')
      cy.window().its('jwt_decode').should('be.a', 'function')
    })

    it('alpha client: /alpha/:conversation_id', () => {
      cy.visit(`/alpha/${conversationId}`)
      cy.contains(/Public libraries|Bus lanes|park needs/, { timeout: 20000 }).should('be.visible')
      expectSelfContained(seen, 'alpha participation', ALPHA_HYDRATION_MISMATCH)
    })
  })

  describe('admin, signed out', () => {
    beforeEach(() => logout())

    for (const page of SIGNED_OUT_ADMIN_PAGES) {

      it(page, () => {
        cy.visit(page)
        cy.contains('Polis is built for the public', { timeout: 20000 }).should('be.visible')
        expectSelfContained(seen, page)
        expectEmojiImage('❤️')
        expectFontLoaded('Space Mono')
      })
    }
  })

  describe('admin, signed in', () => {
    // Signs in through the token endpoint: the sign-in page belongs to the
    // login provider (in tests, a simulator whose page loads its own CDN code).
    beforeEach(() => cy.loginStandardUserAPI(ADMIN, PASSWORD))

    it('/ and the conversation pages', () => {
      cy.visit('/')
      cy.contains('h3', 'All Conversations', { timeout: 20000 }).should('be.visible')
      // The configure page shows the saved-state emoji; then the other tabs.
      cy.visit(`/m/${conversationId}`)
      cy.contains('Up to date', { timeout: 20000 }).should('be.visible')
      expectSelfContained(seen, 'admin configure page')
      expectEmojiImage('⚡')
      expectFontLoaded('Space Mono')
      for (const section of CONVERSATION_ADMIN_SECTIONS) {
        cy.visit(`/m/${conversationId}/${section}`)
        cy.get('#root').children().should('have.length.greaterThan', 0)
      }
      expectSelfContained(seen, 'admin conversation pages')
    })
  })
})
