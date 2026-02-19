/**
 * Alpha client XID (external ID) participant authentication
 *
 * Goal: same xid should resolve to same pid across fresh sessions.
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Alpha Client: XID Participant Authentication', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Test XID Authentication (alpha)',
      description: 'Testing XID participant identity persistence (alpha client)',
      comments: ['XID test comment 1', 'XID test comment 2', 'XID test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('should re-assign the same pid for the same xid across sessions', function () {
    const xid = `e2e-xid-${Date.now()}`
    let pid1

    // --- Session 1 ---
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment1')
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote1')

    cy.visit(`/alpha/${conversationId}?xid=${encodeURIComponent(xid)}`)

    // SSR markup can render before React hydrates; wait for hydration signal.
    cy.get('[data-testid="vote-agree"]').should('be.visible')
    cy.wait('@nextComment1')

    // XID flows may receive the JWT during participationInit (page load),
    // so assert the JWT exists in localStorage before/around the first vote.
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
      .then((token) => {
        const parts = token.split('.')
        expect(parts).to.have.length(3)
        cy.window().then((win) => {
          const payload = JSON.parse(win.atob(parts[1]))
          expect(payload.xid).to.equal(xid)
          expect(payload.pid).to.exist
          pid1 = payload.pid
          cy.log(`✅ First session pid (from JWT): ${pid1}`)
        })
      })

    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote1').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
      expect(interception.response?.body.currentPid).to.exist
      expect(interception.response.body.currentPid).to.equal(pid1)
    })

    // --- Clear all client state to simulate a new session ---
    cy.then(() => {
      cy.clearAllLocalStorage()
    })

    // --- Session 2 ---
    cy.intercept({ method: 'GET', url: '**/api/v3/nextComment*' }).as('nextComment2')
    cy.intercept({ method: 'POST', url: '**/api/v3/votes*' }).as('vote2')

    cy.visit(`/alpha/${conversationId}?xid=${encodeURIComponent(xid)}`)

    cy.get('[data-testid="vote-agree"]').should('be.visible')
    cy.wait('@nextComment2')

    // On a fresh session, the xid alone should resolve to the same pid.
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
      .then((token) => {
        const parts = token.split('.')
        expect(parts).to.have.length(3)
        cy.window().then((win) => {
          const payload = JSON.parse(win.atob(parts[1]))
          expect(payload.xid).to.equal(xid)
          expect(payload.pid).to.equal(pid1)
        })
      })

    cy.get('[data-testid="vote-agree"]').click()
    cy.wait('@vote2').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
      expect(interception.response?.body.currentPid).to.exist

      const pid2 = interception.response.body.currentPid
      cy.log(`✅ Second session pid: ${pid2}`)
      expect(pid2).to.equal(pid1)
    })
  })
})
