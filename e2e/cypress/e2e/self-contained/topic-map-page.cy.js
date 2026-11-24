// The topic map page, /topicsVizReport/<report id>, in a real browser with
// every non-local host blocked. The topic map route is answered with a stored
// document (written by polis-topic-map from its public biodiversity fixture,
// with no comment text, as a Delphi run stores it; CC BY 4.0, see
// queue-rs/polis-topic-map/NOTICE), so this checks the page
// and the map component, not a stored run. Without that answer the route is
// switched off in this stack, and the page says so quietly.

const DOCUMENT = 'topic-map-biodiversity.json'
const TOPIC_MAP_ROUTE = '**/api/v3/delphi/topicMap*'
const MAP_FONT_FILE = /\/static\/topic-map\/Roboto-latin-wght\.[0-9a-f]+\.woff2$/
const REPORT_ID = 'r2topicmapfixture'

const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?`
const NON_LOCAL_URL = new RegExp(String.raw`^(?!https?://${LOCAL_HOST}/)[a-z][a-z0-9+.-]*://`, 'i')

describe('Topic map page', () => {
  let blocked
  let listings
  let topicMapRequests

  beforeEach(() => {
    blocked = []
    listings = []
    topicMapRequests = []
    cy.intercept({ url: NON_LOCAL_URL }, (req) => {
      blocked.push(req.url)
      req.destroy()
    })
    // The datamapplot listings the React page asked for; this page never does.
    cy.intercept({ method: 'GET', url: /\/api\/v3\/delphi(\/visualizations)?(\?|$)/ }, (req) => {
      listings.push(req.url)
    })
  })

  function answerWith(response) {
    cy.intercept('GET', TOPIC_MAP_ROUTE, (req) => {
      topicMapRequests.push({ url: req.url, authorization: req.headers.authorization })
      req.reply(response)
    }).as('topicMap')
  }

  function expectNothingElseAsked(page) {
    // Late requests (the font) fire after the first drawing.
    cy.wait(1000)
    cy.then(() => {
      expect(blocked, `${page}: requests to other hosts`).to.deep.equal([])
      expect(listings, `${page}: requests to the datamapplot listings`).to.deep.equal([])
    })
  }

  // Pixels of the map's canvas that are not its ground, and a signature of
  // what is drawn, read from the canvas itself.
  function drawn() {
    return cy.get('.polis-topic-map-canvas canvas').then(($c) => {
      const canvas = $c[0]
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      const [r0, g0, b0] = [data[0], data[1], data[2]]
      let inked = 0
      let signature = 0
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) > 24) inked += 1
        signature = (signature * 31 + data[i] * 7 + data[i + 1] * 3 + data[i + 2]) % 1000000007
      }
      return { inked, signature, width: canvas.width, height: canvas.height }
    })
  }

  // The signature once two reads half a second apart agree.
  function settled(previous = null, tries = 20) {
    return cy.wait(500).then(() =>
      drawn().then((now) => {
        if (previous && previous.signature === now.signature) return now
        if (tries === 0) throw new Error('the map never stopped changing')
        return settled(now, tries - 1)
      }),
    )
  }

  it('draws the stored map, and its level buttons change what is drawn', () => {
    cy.fixture(DOCUMENT).then((doc) => {
      expect(doc.schema).to.equal('polis-topic-map/1')
      expect(doc.points.text, 'the stored document carries no comment text').to.deep.equal([])
      answerWith({ statusCode: 200, body: doc })
    })
    cy.intercept({ method: 'GET', url: MAP_FONT_FILE }).as('mapFont')

    cy.visit(`/topicsVizReport/${REPORT_ID}`)
    cy.wait('@topicMap')
    cy.then(() => {
      expect(topicMapRequests).to.have.length(1)
      const url = new URL(topicMapRequests[0].url)
      expect(url.pathname).to.equal('/api/v3/delphi/topicMap')
      expect([...url.searchParams.keys()]).to.deep.equal(['report_id'])
      expect(url.searchParams.get('report_id')).to.equal(REPORT_ID)
      expect(topicMapRequests[0].authorization, 'no credential').to.equal(undefined)
    })

    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    cy.get('.polis-topic-map-levels button').should('have.length', 3) // two levels, then all together
    cy.get('.polis-topic-map-levels button').first().should('have.attr', 'aria-pressed', 'true')
    cy.get('.polis-topic-map-rules button').should('have.length', 2)
    cy.wait('@mapFont', { timeout: 20000 }).its('response.statusCode').should('equal', 200)

    settled().then((first) => {
      expect(first.width, 'canvas backing width').to.be.greaterThan(100)
      expect(first.height, 'canvas backing height').to.be.greaterThan(100)
      expect(first.inked, 'pixels drawn on the ground').to.be.greaterThan(2000)

      cy.get('.polis-topic-map-levels button').eq(1).click()
      cy.get('.polis-topic-map-levels button').eq(1).should('have.attr', 'aria-pressed', 'true')
      settled().then((second) => {
        expect(second.signature, 'level 1 draws differently from level 0').to.not.equal(first.signature)
        expect(second.inked).to.be.greaterThan(2000)

        cy.get('.polis-topic-map-levels button').eq(2).click()
        settled().then((all) => {
          expect(all.signature, 'all levels together draw differently again').to.not.equal(second.signature)
        })
      })
    })

    // Dark by default: the page's ground is the dark theme's.
    cy.get('body').should('have.css', 'background-color', 'rgb(18, 18, 18)')
    expectNothingElseAsked('/topicsVizReport')
  })

  it('?theme=light draws on the neutral theme, and ?job_id names the run', () => {
    cy.fixture(DOCUMENT).then((doc) => answerWith({ statusCode: 200, body: doc }))
    cy.visit(`/topicsVizReport/${REPORT_ID}?theme=light&job_id=f5387f40-25d2-478e-82fe-19f4b2fb5984`)
    cy.wait('@topicMap').its('request.url').then((u) => {
      const url = new URL(u)
      expect([...url.searchParams.keys()]).to.deep.equal(['report_id', 'job_id'])
      expect(url.searchParams.get('job_id')).to.equal('f5387f40-25d2-478e-82fe-19f4b2fb5984')
    })
    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    cy.get('body').should('have.css', 'background-color', 'rgb(255, 255, 255)')
    settled().its('inked').should('be.greaterThan', 2000)
    expectNothingElseAsked('/topicsVizReport?theme=light')
  })

  it('with the route switched off (Node answers 404), says quietly that no map is stored', () => {
    cy.visit(`/topicsVizReport/${REPORT_ID}`)
    cy.contains('.polis-topic-map-message', 'No topic map is stored for this report yet.', { timeout: 20000 })
    cy.get('.polis-topic-map-canvas canvas').should('not.exist')
    cy.get('.polis-topic-map-controls').should('not.exist')
    expectNothingElseAsked('/topicsVizReport, route off')
  })

  const ANSWERS = [
    {
      title: '200 not_stored',
      response: {
        statusCode: 200,
        body: { status: 'success', reason: 'not_stored', message: 'The Delphi run has no stored topic map' },
      },
      text: 'No topic map is stored for this report yet.',
    },
    {
      title: '404 from the route: no such report',
      response: { statusCode: 404, body: { status: 'error', message: 'Could not find conversation for report_id' } },
      text: 'There is no report at this address.',
    },
    {
      title: '503 busy',
      response: {
        statusCode: 503,
        headers: { 'Retry-After': '1' },
        body: { status: 'error', message: 'polis_err_topic_map_busy' },
      },
      text: 'Too many requests for the topic map just now. Reload the page in a moment.',
    },
  ]

  for (const { title, response, text } of ANSWERS) {

    it(`answer ${title}: "${text}"`, () => {
      answerWith(response)
      cy.visit(`/topicsVizReport/${REPORT_ID}`)
      cy.wait('@topicMap')
      cy.contains('.polis-topic-map-message', text, { timeout: 20000 })
      cy.then(() => expect(topicMapRequests, 'asked once, never again').to.have.length(1))
      expectNothingElseAsked(`/topicsVizReport, ${title}`)
    })
  }
})
