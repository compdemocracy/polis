import {
  loginStandardUserAPI,
  logout,
  getAuthToken,
} from '../../support/auth-helpers.js'
import {
  createTestConversationAPI,
  addCommentsToConversationNoAuth,
} from '../../support/conversation-helpers.js'

const ADMIN_EMAIL = 'admin@polis.test'
const ADMIN_PASSWORD = 'Te$tP@ssw0rd*'

function createConversationWithSeedComment(topicSuffix = 'Conversation') {
  const timestamp = Date.now()
  const topic = `Participant Management ${topicSuffix} ${timestamp}`
  const description = 'Conversation created by Cypress for participant management tests'

  return createTestConversationAPI({ topic, description }).then((conversationId) => {
    return addCommentsToConversationNoAuth(conversationId, ['Seed comment for participant testing']).then(
      () => conversationId,
    )
  })
}

function updateConversation(conversationId, updateFn) {
  return getAuthToken().then((token) => {
    return cy
      .request({
        method: 'GET',
        url: `/api/v3/conversations?conversation_id=${conversationId}`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      .then((response) => {
        expect(response.status).to.eq(200)
        const conversationData = {
          ...response.body,
          conversation_id: conversationId,
        }
        const updatedData = updateFn(conversationData) || conversationData
        return cy.request({
          method: 'PUT',
          url: '/api/v3/conversations',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: updatedData,
        })
      })
  })
}

function setAllowList(conversationId, xids, replaceAll = true) {
  return getAuthToken().then((token) => {
    return cy.request({
      method: 'POST',
      url: '/api/v3/xidAllowList',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        conversation_id: conversationId,
        xid_allow_list: xids,
        replace_all: replaceAll,
      },
    })
  })
}

describe('Client Admin: Participant Management', () => {
  beforeEach(() => {
    loginStandardUserAPI(ADMIN_EMAIL, ADMIN_PASSWORD).then(() => {
      cy.visit('/')
      cy.contains('h3', 'All Conversations', { timeout: 15000 }).should('be.visible')
    })
  })

  it('shows participant management toggles and empty state', () => {
    createConversationWithSeedComment('Default state').then((conversationId) => {
      cy.intercept('GET', '/api/v3/xids*').as('loadXids')

      cy.visit(`/m/${conversationId}/participants`)
      cy.wait('@loadXids')

      cy.contains('h3', 'Participant Management').should('be.visible')
      cy.contains(`conversation ${conversationId}`).should('be.visible')

      cy.get('[data-testid="xid_required"]').should('not.be.checked')
      cy.get('[data-testid="use_xid_whitelist"]').should('not.be.checked')

      cy.contains('No XIDs found for this conversation.').should('be.visible')
      cy.contains('button', 'XIDs in Use').should('be.visible')
    })
  })

  it('renders XIDs in use when participants exist', () => {
    const xid = `cypress-xid-${Date.now()}`

    createConversationWithSeedComment('XIDs in use').then((conversationId) => {
      cy.request({
        method: 'GET',
        url: '/api/v3/participationInit',
        qs: {
          conversation_id: conversationId,
          xid,
          pid: -1,
          lang: 'en',
        },
      })
        .its('status')
        .should('eq', 200)

      cy.intercept('GET', '/api/v3/xids*').as('loadXids')

      cy.visit(`/m/${conversationId}/participants`)
      cy.wait('@loadXids')

      cy.contains('td', xid).should('be.visible')
    })
  })

  it('shows and updates XID allow list entries', () => {
    const initialXids = [`allowed-${Date.now()}`, `allowed-${Date.now() + 1}`]
    const uploadedXids = [`uploaded-${Date.now() + 2}`, `uploaded-${Date.now() + 3}`]

    createConversationWithSeedComment('Allow list').then((conversationId) => {
      setAllowList(conversationId, initialXids).its('status').should('eq', 200)

      cy.intercept('GET', '/api/v3/xidAllowList*').as('loadAllowList')
      cy.intercept('POST', '/api/v3/xidAllowList').as('uploadXids')

      cy.visit(`/m/${conversationId}/participants`)
      cy.contains('button', 'XIDs Allowed').click()

      cy.wait('@loadAllowList')

      initialXids.forEach((xid) => {
        cy.contains('td', xid).should('be.visible')
      })

      cy.contains('button', 'Upload XIDs').click()
      cy.contains('h3', 'Upload XIDs').should('be.visible')

      cy.get('textarea[placeholder*="Paste XIDs"]').type(
        `${uploadedXids[0]}{enter}${uploadedXids[1]}`,
        { delay: 0 },
      )

      cy.get('button').filter(':contains("Upload XIDs")').last().click()

      cy.wait('@uploadXids').its('response.statusCode').should('eq', 200)
      cy.wait('@loadAllowList')

      uploadedXids.forEach((xid) => {
        cy.contains('td', xid).should('be.visible')
      })
    })
  })

  it('enforces XID allow list when enabled', () => {
    const allowedXid = `allow-${Date.now()}`

    createConversationWithSeedComment('Enforce allow list').then((conversationId) => {
      updateConversation(conversationId, (conversationData) => {
        return {
          ...conversationData,
          use_xid_whitelist: true,
          xid_required: true,
        }
      })
        .its('status')
        .should('eq', 200)

      setAllowList(conversationId, [allowedXid], true).its('status').should('eq', 200)

      logout()

      cy.intercept('POST', '/api/v3/votes').as('voteWithoutXid')
      cy.visit(`/${conversationId}`)
      cy.get('#agreeButton', { timeout: 15000 }).should('be.visible')
      cy.window().then((win) => {
        cy.stub(win, 'alert').as('missingXidAlert')
      })
      cy.get('#agreeButton').click()
      cy.wait('@voteWithoutXid').its('response.statusCode').should('eq', 403)
      cy.get('@missingXidAlert')
        .should('have.been.called')
        .its('firstCall.args.0')
        .should('contain', 'This conversation requires an XID')

      cy.clearAllLocalStorage()
      cy.clearAllCookies()

      cy.intercept('POST', '/api/v3/votes').as('voteWithXid')
      cy.visit(`/${conversationId}?xid=${allowedXid}`)
      cy.get('#agreeButton', { timeout: 15000 }).should('be.visible')
      cy.window().then((win) => {
        cy.stub(win, 'alert').as('allowedXidAlert')
      })
      cy.get('#agreeButton').click()
      cy.wait('@voteWithXid').its('response.statusCode').should('eq', 200)
      cy.get('@allowedXidAlert').should('not.have.been.called')
    })
  })

  it('requires an XID when xid_required is true', () => {
    const providedXid = `xid-required-${Date.now()}`

    createConversationWithSeedComment('Require xid').then((conversationId) => {
      updateConversation(conversationId, (conversationData) => {
        return {
          ...conversationData,
          use_xid_whitelist: false,
          xid_required: true,
        }
      })
        .its('status')
        .should('eq', 200)

      logout()

      cy.intercept('POST', '/api/v3/votes').as('voteWithoutXid')
      cy.visit(`/${conversationId}`)
      cy.get('#agreeButton', { timeout: 15000 }).should('be.visible')
      cy.window().then((win) => {
        cy.stub(win, 'alert').as('missingXidAlert')
      })
      cy.get('#agreeButton').click()
      cy.wait('@voteWithoutXid').its('response.statusCode').should('eq', 403)
      cy.get('@missingXidAlert')
        .should('have.been.called')
        .its('firstCall.args.0')
        .should('contain', 'This conversation requires an XID')

      cy.clearAllLocalStorage()
      cy.clearAllCookies()

      cy.intercept('POST', '/api/v3/votes').as('voteWithXid')
      cy.visit(`/${conversationId}?xid=${providedXid}`)
      cy.get('#agreeButton', { timeout: 15000 }).should('be.visible')
      cy.window().then((win) => {
        cy.stub(win, 'alert').as('xidProvidedAlert')
      })
      cy.get('#agreeButton').click()
      cy.wait('@voteWithXid').its('response.statusCode').should('eq', 200)
      cy.get('@xidProvidedAlert').should('not.have.been.called')
    })
  })
})
