import { setupTestConversation } from '../../support/conversation-helpers.js'
// Observe consumption, not just network completion: cy.wait(intercept) can
// finish before the browser has parsed the body and delivered its callback.
function observeFirstSelectionRead(win) {
  const fetch = win.fetch.bind(win)
  let first = true
  win.fetch = (...args) => {
    const tracked = first && String(args[0]).includes('/api/v3/nextComment')
    if (tracked) first = false
    return fetch(...args).then((response) => {
      if (tracked) {
        const json = response.json.bind(response)
        response.json = () =>
          json().then((body) => {
            win.setTimeout(() => {
              win.firstSelectionRead = true
            }, 0)
            return body
          })
      }
      return response
    })
  }
}

// Replay one real server-rendered document so the initial weighted draw is fixed
// across race controls and reload. No selector policy or random seed is changed.
// The returning-voter check and vote below still use the real authenticated API.
describe('Alpha Client: retained blended SSR choice', function () {
  let conversationId
  let renderedFirst
  let ssrHTML
  const second = { tid: 701, txt: 'Synthetic next blended choice', remaining: 1 }

  before(function () {
    setupTestConversation({ topic: 'Retained SSR regression', comments: ['SSR seed A', 'SSR seed B', 'SSR seed C'] })
      .then(result => {
        conversationId = result.conversationId
        return cy.request(`/alpha/${conversationId}`)
      }).then(({ body }) => {
        ssrHTML = body
        const text = new DOMParser().parseFromString(body, 'text/html').querySelector('.statement-text').textContent.trim()
        return cy.request(`/api/v3/comments?conversation_id=${conversationId}`).then(({ body: comments }) => {
          renderedFirst = comments.find(comment => comment.txt === text)
          expect(renderedFirst).to.be.an('object')
        })
      })
  })

  beforeEach(function () {
    cy.clearAllLocalStorage()
    cy.intercept('GET', `/alpha/${conversationId}*`, { statusCode: 200, headers: { 'content-type': 'text/html' }, body: ssrHTML })
  })

  it('SSR displays its SSR choice and hydration retains it until an actual vote', function () {
    cy.request(`/alpha/${conversationId}`).then(({ body }) => {
      expect(body).to.contain('class="statement-text"')
    })
    let release
    cy.intercept('GET', '**/api/v3/nextComment*', req => new Promise(resolve => {
      release = () => {
        // The old browser makes a second blended draw without the preferred tid.
        req.reply(req.query.initial_tid === String(renderedFirst.tid)
          ? { ...renderedFirst, initialStatus: 'eligible' } : second)
        resolve()
      }
    })).as('check')
    cy.visit(`/alpha/${conversationId}`)
    cy.get('.statement-text').should('have.text', renderedFirst.txt).and('be.visible')
    cy.get('[data-testid="vote-agree"]').should('be.disabled')
    cy.wrap(null).should(() => expect(release).to.be.a('function')).then(() => release())
    cy.wait('@check')
    cy.get('.statement-text').should('have.text', renderedFirst.txt)
    cy.get('[data-testid="vote-agree"]').should('be.enabled')
    cy.intercept('POST', '**/api/v3/votes*', { nextComment: second }).as('vote')
    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote').its('request.body.tid').should('eq', renderedFirst.tid)
    cy.get('.statement-text').should('have.text', second.txt)
  })
  for (const [name, late] of [['nonempty', { ...second, initialStatus: 'voted' }], ['empty', {}]]) {

    it(`late ${name} check cannot overwrite the accepted vote`, function () {
      let release
      let count = 0
      cy.intercept('GET', '**/api/v3/nextComment*', req => {
        count += 1
        if (count === 1) {
          req.alias = 'old'
          return new Promise(resolve => { release = () => { req.reply({ statusCode: 200, body: late }); resolve() } })
        }
        req.alias = 'new'
        req.reply({ ...renderedFirst, initialStatus: 'eligible' })
      })
      const afterVote = { tid: 703, txt: 'Accepted next survives', remaining: 1 }
      cy.intercept('POST', '**/api/v3/votes*', { nextComment: afterVote }).as('vote')
      cy.visit(`/alpha/${conversationId}`, { onBeforeLoad: observeFirstSelectionRead })
      cy.wrap(null).should(() => expect(release).to.be.a('function'))
      cy.window().then(win => {
        win.history.replaceState(null, '', `${win.location.pathname}?ui_lang=fr`)
        win.dispatchEvent(new win.Event('login-code-submitted'))
      })
      cy.wait('@new')
      cy.get('[data-testid="vote-agree"]').should('be.enabled').click()
      cy.wait('@vote')
      cy.get('.statement-text').should('have.text', afterVote.txt)
      cy.then(() => release())
      cy.wait('@old')
      cy.window().its('firstSelectionRead').should('eq', true)
      cy.window().then(win => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))))
      cy.get('.statement-text').should('have.text', afterVote.txt)
      cy.get('.email-subscribe-container').should('not.exist')
    })
  }

  it('same-identity auth refresh cannot perform another draw', function () {
    let calls = 0
    cy.intercept('GET', '**/api/v3/nextComment*', req => {
      calls += 1
      req.reply(calls === 1 ? { ...renderedFirst, initialStatus: 'eligible' } : second)
    }).as('check')
    cy.visit(`/alpha/${conversationId}`)
    cy.wait('@check')
    cy.get('[data-testid="vote-agree"]').should('be.enabled')
    cy.window().then(win => win.dispatchEvent(new win.Event('login-code-submitted')))
    cy.window().then(win => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))))
    cy.get('.statement-text').should('have.text', renderedFirst.txt)
    cy.then(() => expect(calls).to.equal(1))
  })

  it('real API returning voter never reveals the already-voted SSR choice on reload', function () {
    cy.intercept('GET', '**/api/v3/nextComment*').as('check')
    cy.intercept('POST', '**/api/v3/votes*').as('vote')
    cy.visit(`/alpha/${conversationId}`)
    cy.wait('@check').its('response.body.initialStatus').should('eq', 'eligible')
    cy.get('.statement-text').should('have.text', renderedFirst.txt)
    cy.get('[data-testid="vote-agree"]').should('be.enabled').click()
    cy.wait('@vote').its('response.statusCode').should('eq', 200)
    let release
    cy.intercept('GET', '**/api/v3/nextComment*', req => new Promise(resolve => {
      release = () => { req.continue(); resolve() }
    })).as('returning')
    cy.reload()
    cy.wrap(null).should(() => expect(release).to.be.a('function'))
    cy.get('html').should('have.attr', 'data-polis-returning')
    cy.get('[data-initial-statement]').should('not.be.visible')
    cy.get('[data-testid="vote-agree"]').should('be.disabled')
    cy.then(() => release())
    cy.wait('@returning').then(({ response }) => {
      expect(response.body.initialStatus).to.equal('voted')
      expect(response.body.tid).not.to.equal(renderedFirst.tid)
      cy.get('.statement-text').should('have.text', response.body.txt).and('be.visible')
    })
    cy.get('[data-testid="vote-agree"]').should('be.enabled')
  })
})
