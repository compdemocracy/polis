// The topic map page, /topicsVizReport/<report id>, in a real browser with
// every non-local host blocked. The topic map route is answered with a stored
// document (written by polis-topic-map from its public biodiversity fixture,
// with no comment text, as a Delphi run stores it; CC BY 4.0, see
// queue-rs/polis-topic-map/NOTICE), so this checks the page
// and the map component, not a stored run. Without that answer the route is
// switched off in this stack, and the page says so quietly.
//
// The held-back fixture is the same document in the form the route sends a
// public reader when comments are held back (every comment whose id is a
// multiple of 4: bare points, last), written by
// client-topic-map-embed/tools/held-back-fixture.mjs.

const DOCUMENT = 'topic-map-biodiversity.json'
const HELD_BACK = 'topic-map-biodiversity-held-back.json'
const TOPIC_MAP_ROUTE = '**/api/v3/delphi/topicMap*'
const MAP_FONT_FILE = /\/static\/topic-map\/Roboto-latin-wght\.[0-9a-f]+\.woff2$/
const REPORT_ID = 'r2topicmapfixture'

const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?`
const NON_LOCAL_URL = new RegExp(String.raw`^(?!https?://${LOCAL_HOST}/)[a-z][a-z0-9+.-]*://`, 'i')

describe('Topic map page', () => {
  let blocked
  let listings
  let topicMapRequests
  let listRequests
  let textRequests
  let textAnswer

  beforeEach(() => {
    textAnswer = null
    blocked = []
    listings = []
    topicMapRequests = []
    listRequests = []
    textRequests = []
    // The two reads that give comment text: recorded, and answered when a
    // test sets textAnswer.
    cy.intercept({ method: 'GET', url: /\/api\/v3\/(reports|comments)\?/ }, (req) => {
      textRequests.push(req.url)
      if (textAnswer) req.reply(textAnswer(new URL(req.url)))
    })
    cy.intercept({ url: NON_LOCAL_URL }, (req) => {
      blocked.push(req.url)
      req.destroy()
    })
    // The datamapplot listings the React page asked for; this page never does.
    cy.intercept({ method: 'GET', url: /\/api\/v3\/delphi(\/visualizations)?(\?|$)/ }, (req) => {
      listings.push(req.url)
    })
  })

  // The map request is answered with `response`; the list of runs
  // (list=jobs) with `list`, by default as Node answers an API path it does
  // not know, which is what a route without the list answers.
  const NO_LIST = { statusCode: 404, body: 'Not Found', headers: { 'content-type': 'text/plain' } }
  function answerWith(response, list = NO_LIST) {
    cy.intercept('GET', TOPIC_MAP_ROUTE, (req) => {
      const url = new URL(req.url)
      if (url.searchParams.get('list') === 'jobs') {
        req.alias = 'jobList'
        listRequests.push({ url: req.url, authorization: req.headers.authorization })
        req.reply(list)
        return
      }
      req.alias = 'topicMap'
      topicMapRequests.push({ url: req.url, authorization: req.headers.authorization })
      req.reply(typeof response === 'function' ? response(url) : response)
    })
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

  // Places on the canvas (in CSS pixels) whose colour is grey and not the
  // ground: where a point with no topic is drawn.
  function greyPlaces() {
    return cy.get('.polis-topic-map-canvas canvas').then(($c) => {
      const canvas = $c[0]
      const scale = canvas.width / canvas.getBoundingClientRect().width
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      const [r0, g0, b0] = [data[0], data[1], data[2]]
      const seen = new Set()
      const places = []
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const i = (y * canvas.width + x) * 4
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
          const grey = Math.abs(r - g) < 6 && Math.abs(g - b) < 6
          const off = Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > 30
          const cell = `${Math.floor(x / (6 * scale))},${Math.floor(y / (6 * scale))}`
          if (grey && off && !seen.has(cell)) {
            seen.add(cell)
            places.push([x / scale, y / scale])
          }
        }
      }
      return places
    })
  }

  // Moves the pointer over each place until the tooltip says `text`.
  function pointUntil(places, text, k = 0) {
    if (k >= Math.min(places.length, 80)) throw new Error(`no place on the map shows "${text}"`)
    const [x, y] = places[k]
    cy.get('.polis-topic-map-canvas canvas').trigger('pointermove', x, y, { pointerId: 1, force: true })
    return cy.get('.polis-topic-map-canvas > div').then(($t) => {
      if ($t.css('display') === 'block' && $t.text() === text) return [x, y]
      return pointUntil(places, text, k + 1)
    })
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

  it('held-back comments draw grey, the counts are stated, and their tooltip says "Moderated out"', () => {
    cy.fixture(HELD_BACK).then((doc) => {
      expect(doc.points.moderatedOut).to.equal(39)
      answerWith({ statusCode: 200, body: doc })
      // The report gives its conversation id; the comment list, text for
      // every comment it holds.
      const comments = doc.points.id.filter((id) => id !== null).map((tid) => ({ tid, txt: `Comment ${tid}` }))
      textAnswer = (url) =>
        url.pathname === '/api/v3/reports'
          ? { statusCode: 200, body: [{ report_id: REPORT_ID, conversation_id: '2fixture' }] }
          : { statusCode: 200, body: comments }
    })
    cy.visit(`/topicsVizReport/${REPORT_ID}`)
    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    cy.contains('.polis-topic-map-counts', '154 comments · 39 moderated out, shown grey')
    cy.then(() => expect(textRequests, 'no comment text asked for before the pointer is on the map').to.deep.equal([]))
    settled().then((now) => expect(now.inked).to.be.greaterThan(2000))

    greyPlaces().then((places) => {
      expect(places.length, 'grey places on the map').to.be.greaterThan(10)
      // The first move over the map asks for the text, once.
      cy.get('.polis-topic-map-canvas canvas').trigger('pointermove', 5, 5, { pointerId: 1, force: true })
      cy.wrap(null).should(() => expect(textRequests).to.have.length(2))
      cy.then(() => {
        const [report, comments] = textRequests.map((u) => new URL(u))
        expect(report.pathname).to.equal('/api/v3/reports')
        expect([...report.searchParams.entries()]).to.deep.equal([['report_id', REPORT_ID]])
        expect(comments.pathname).to.equal('/api/v3/comments')
        expect([...comments.searchParams.entries()]).to.deep.equal([
          ['conversation_id', '2fixture'],
          ['report_id', REPORT_ID],
          ['moderation', 'true'],
        ])
      })
      pointUntil(places, 'Moderated out')
    })
    // A point that is not held back shows its comment's text.
    drawn()
    cy.get('.polis-topic-map-canvas canvas').then(($c) => {
      const canvas = $c[0]
      const scale = canvas.width / canvas.getBoundingClientRect().width
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      const places = []
      for (let y = 0; y < canvas.height; y += 3) {
        for (let x = 0; x < canvas.width; x += 3) {
          const i = (y * canvas.width + x) * 4
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
          if (Math.max(r, g, b) - Math.min(r, g, b) > 60) places.push([x / scale, y / scale])
        }
      }
      const tried = places.filter((_, k) => k % 7 === 0)
      const tryNext = (k) => {
        if (k >= Math.min(tried.length, 120)) throw new Error('no coloured point shows its text')
        cy.get('.polis-topic-map-canvas canvas').trigger('pointermove', tried[k][0], tried[k][1], { pointerId: 1, force: true })
        return cy.get('.polis-topic-map-canvas > div').then(($t) => {
          if ($t.css('display') === 'block' && /^Comment \d+$/.test($t.text())) return
          return tryNext(k + 1)
        })
      }
      tryNext(0)
    })
    cy.then(() => expect(textRequests, 'the text is asked for once').to.have.length(2))
    expectNothingElseAsked('/topicsVizReport, held back')
  })

  const RUNS = {
    report_id: REPORT_ID,
    jobs: [
      {
        job_id: 'job-held-back',
        source: 'served',
        selection: 'participant_visible',
        created_at: '2026-11-24T14:05:00Z',
        points: 154,
        levels: [10, 4],
        names: { by: 'keywords', model: null },
        current: true,
      },
      {
        job_id: 'job-stored',
        source: 'shadow',
        selection: 'all_but_moderated_out',
        created_at: '2026-11-11T02:48:21Z',
        points: 154,
        levels: [10, 4],
        names: { by: 'model', model: 'qwen2.5:1.5b' },
        current: false,
      },
    ],
  }

  it('with two runs, a chooser names them; choosing the second draws it and puts its job_id in the address', () => {
    cy.fixture(HELD_BACK).then((heldBack) =>
      cy.fixture(DOCUMENT).then((stored) => {
        answerWith((url) => ({ statusCode: 200, body: url.searchParams.get('job_id') === 'job-stored' ? stored : heldBack }), {
          statusCode: 200,
          body: RUNS,
        })
      }),
    )
    cy.visit(`/topicsVizReport/${REPORT_ID}?theme=dark`)
    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    cy.get('.polis-topic-map-jobs select option').should('have.length', 2)
    cy.get('.polis-topic-map-jobs select option').eq(0).should('have.text', 'what participants see · keyword names · 2026-11-24 14:05 UTC · 154 comments · current')
    cy.get('.polis-topic-map-jobs select option').eq(1).should('have.text', 'everything not moderated out · qwen2.5:1.5b · 2026-11-11 02:48 UTC · 154 comments')
    cy.get('.polis-topic-map-jobs select').should('have.value', 'job-held-back')
    cy.contains('.polis-topic-map-counts', '39 moderated out')
    cy.then(() => {
      expect(listRequests).to.have.length(1)
      const url = new URL(listRequests[0].url)
      expect([...url.searchParams.entries()]).to.deep.equal([['report_id', REPORT_ID], ['list', 'jobs']])
      expect(listRequests[0].authorization, 'no credential').to.equal(undefined)
      expect(topicMapRequests).to.have.length(1)
      expect([...new URL(topicMapRequests[0].url).searchParams.keys()]).to.deep.equal(['report_id'])
    })

    cy.get('.polis-topic-map-jobs select').select('job-stored')
    cy.location('search').should('equal', '?theme=dark&job_id=job-stored')
    cy.get('.polis-topic-map-counts').should('not.exist')
    cy.get('.polis-topic-map[data-state="map"]')
    cy.then(() => {
      expect(topicMapRequests).to.have.length(2)
      const url = new URL(topicMapRequests[1].url)
      expect([...url.searchParams.entries()]).to.deep.equal([['report_id', REPORT_ID], ['job_id', 'job-stored']])
      expect(listRequests, 'the list is asked for once').to.have.length(1)
    })
    settled().its('inked').should('be.greaterThan', 2000)
    expectNothingElseAsked('/topicsVizReport, two runs')
  })

  it('without the list (the route does not answer it), there is no chooser and the map draws', () => {
    cy.fixture(DOCUMENT).then((doc) => answerWith({ statusCode: 200, body: doc }))
    cy.visit(`/topicsVizReport/${REPORT_ID}`)
    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    settled().its('inked').should('be.greaterThan', 2000)
    cy.get('.polis-topic-map-jobs').should('not.exist')
    cy.get('.polis-topic-map-counts').should('not.exist')
    cy.then(() => expect(listRequests).to.have.length(1))
    expectNothingElseAsked('/topicsVizReport, no list')
  })

  it('?chooser=0 asks for no list', () => {
    cy.fixture(DOCUMENT).then((doc) => answerWith({ statusCode: 200, body: doc }, { statusCode: 200, body: RUNS }))
    cy.visit(`/topicsVizReport/${REPORT_ID}?chooser=0`)
    cy.get('.polis-topic-map[data-state="map"]', { timeout: 20000 })
    cy.wait(1000)
    cy.get('.polis-topic-map-jobs').should('not.exist')
    cy.then(() => expect(listRequests).to.deep.equal([]))
    expectNothingElseAsked('/topicsVizReport?chooser=0')
  })
})
