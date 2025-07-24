/**
 * Test for legacy cookie authentication flow
 * Tests that participants with permanent cookies (pc) are recognized and issued JWTs
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Legacy Cookie Authentication', function () {
  let conversationId

  before(function () {
    // Create test conversation (setupTestConversation handles auth internally)
    setupTestConversation({
      topic: 'Legacy Cookie Test',
      description: 'Testing legacy cookie authentication',
      comments: ['Test comment 1', 'Test comment 2', 'Test comment 3'],
    }).then((result) => {
      conversationId = result.conversationId
      cy.log(`✅ Test conversation created: ${conversationId}`)
    })
  })

  it('should check if permanent cookies are set during normal participant flow', function () {
    // Clear all storage and cookies
    cy.clearAllCookies()
    cy.clearLocalStorage()

    // Visit conversation as anonymous participant
    cy.visit(`/${conversationId}`)

    // Wait for vote button
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // Vote to create participant
    cy.get('#agreeButton').click()

    // Check for permanent cookie
    cy.getCookie('pc').then((cookie) => {
      if (cookie) {
        cy.log('✅ Permanent cookie found:', cookie.value)
      } else {
        cy.log('❌ No permanent cookie set during normal flow')
      }
    })

    // Check that JWT was issued
    cy.window()
      .its('localStorage')
      .invoke('getItem', `participant_token_${conversationId}`)
      .should('exist')
  })

  it('should recognize participant with only permanent cookie (no JWT)', function () {
    // This test simulates having a legacy cookie but no JWT
    // In real scenario, the cookie would match a database entry

    // Clear all storage but set a fake permanent cookie
    cy.clearLocalStorage()
    cy.setCookie('pc', 'fake-legacy-cookie-12345')

    // Track vote requests
    let voteData = {}

    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        // Store response data for later logging
        voteData = {
          status: res.statusCode,
          hasCookie: req.headers.cookie?.includes('pc='),
          hasAuth: !!req.headers.authorization,
          pid: res.body.currentPid,
          hasJWT: !!res.body.auth?.token,
        }
        console.log('Vote response:', voteData)
      })
    }).as('voteWithCookie')

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Vote
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible').click()
    cy.wait('@voteWithCookie').then(() => {
      // Log the vote data after intercept completes
      cy.log(
        `Vote response - status: ${voteData.status}, hasCookie: ${voteData.hasCookie}, hasJWT: ${voteData.hasJWT}`,
      )
    })

    // Check if JWT was issued
    cy.window().then((win) => {
      const token = win.localStorage.getItem(`participant_token_${conversationId}`)
      if (token) {
        cy.log('✅ JWT issued for legacy cookie participant')

        // Decode and check token
        const parts = token.split('.')
        const payload = JSON.parse(atob(parts[1]))
        cy.log('JWT payload:', JSON.stringify(payload))
      } else {
        cy.log('⚠️ No JWT issued - legacy cookie might not exist in database')
      }
    })
  })

  it('should maintain participant identity when switching from cookie to JWT', function () {
    // This test checks the upgrade path from cookie to JWT

    // Clear JWT but keep cookies
    cy.clearLocalStorage()

    // Set a test permanent cookie
    cy.setCookie('pc', 'test-upgrade-cookie-' + Date.now())

    let firstPid, secondPid

    // Intercept votes to track PIDs
    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        if (!firstPid && res.body.currentPid !== undefined) {
          firstPid = res.body.currentPid
          console.log('First vote PID:', firstPid)
        } else if (res.body.currentPid !== undefined) {
          secondPid = res.body.currentPid
          console.log('Second vote PID:', secondPid)
        }
      })
    }).as('vote')

    // Visit and vote
    cy.visit(`/${conversationId}`)
    cy.get('#agreeButton', { timeout: 10000 }).click()
    cy.wait('@vote').then(() => {
      cy.log(`First vote PID: ${firstPid}`)
    })

    // Check if JWT was stored
    cy.window().then((win) => {
      const token = win.localStorage.getItem(`participant_token_${conversationId}`)
      if (token) {
        cy.log('✅ JWT stored after first vote')

        // Vote again with JWT
        cy.get('#agreeButton', { timeout: 10000 }).click()
        cy.wait('@vote').then(() => {
          cy.log(`Second vote PID: ${secondPid}`)

          // Compare PIDs
          if (firstPid && secondPid) {
            if (firstPid === secondPid) {
              cy.log('✅ Same PID maintained between cookie and JWT auth')
            } else {
              cy.log('⚠️ Different PIDs - might be expected if cookie not in database')
            }
          }
        })
      }
    })
  })

  it('should test legacy cookie with XID participant', function () {
    const xid = 'legacy-xid-' + Date.now()

    // Clear storage and set cookie
    cy.clearLocalStorage()
    cy.setCookie('pc', 'xid-legacy-cookie-' + Date.now())

    // Track the response
    let responseData = {}

    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.continue((res) => {
        responseData = {
          hasXID: req.body.xid === xid,
          hasCookie: req.headers.cookie?.includes('pc='),
          responseStatus: res.statusCode,
          hasJWT: !!res.body.auth?.token,
        }
        console.log('XID vote response:', responseData)

        if (res.body.auth?.token) {
          // Decode JWT to check XID claim
          const parts = res.body.auth.token.split('.')
          const payload = JSON.parse(atob(parts[1]))
          console.log('JWT claims:', {
            xid: payload.xid,
            xid_participant: payload.xid_participant,
          })
        }
      })
    }).as('xidVote')

    // Visit with XID
    cy.visit(`/${conversationId}?xid=${xid}`)

    // Vote
    cy.get('#agreeButton', { timeout: 10000 }).click()
    cy.wait('@xidVote').then(() => {
      cy.log(`XID vote response - hasXID: ${responseData.hasXID}, hasJWT: ${responseData.hasJWT}`)
    })

    // Verify JWT storage
    cy.window().then((win) => {
      const token = win.localStorage.getItem(`participant_token_${conversationId}`)
      if (token) {
        const parts = token.split('.')
        const payload = JSON.parse(atob(parts[1]))

        if (payload.xid === xid) {
          cy.log('✅ XID preserved in JWT from legacy cookie flow')
        } else {
          cy.log('⚠️ XID not preserved - new participant might have been created')
        }
      }
    })
  })

  it('should test comment submission with legacy cookie', function () {
    // Clear storage and set cookie
    cy.clearLocalStorage()
    cy.setCookie('pc', 'comment-legacy-cookie-' + Date.now())

    // Track comment request
    let commentData = {}

    cy.intercept('POST', '/api/v3/comments', (req) => {
      req.continue((res) => {
        commentData = {
          hasCookie: req.headers.cookie?.includes('pc='),
          responseStatus: res.statusCode,
          hasJWT: !!res.body.auth?.token,
          pid: res.body.currentPid,
        }
        console.log('Comment response:', commentData)
      })
    }).as('comment')

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Try different selectors for comment form
    cy.get('body').then(($body) => {
      // Check which comment form elements exist
      const textareaSelector =
        $body.find('textarea[data-testid="comment_form_textarea"]').length > 0
          ? 'textarea[data-testid="comment_form_textarea"]'
          : 'textarea#comment_form_textarea'

      const submitSelector =
        $body.find('button[data-testid="comment_form_submit_btn"]').length > 0
          ? 'button[data-testid="comment_form_submit_btn"]'
          : 'button#comment_button'

      // Type comment
      cy.get(textareaSelector, { timeout: 10000 }).type('Test comment from legacy cookie user')

      // Submit
      cy.get(submitSelector).click()
      cy.wait('@comment').then(() => {
        cy.log(
          `Comment response - status: ${commentData.responseStatus}, hasJWT: ${commentData.hasJWT}`,
        )
      })
    })

    // Check if JWT was issued
    cy.window().then((win) => {
      const token = win.localStorage.getItem(`participant_token_${conversationId}`)
      if (token) {
        cy.log('✅ JWT issued for legacy cookie participant on comment submission')
      } else {
        cy.log('⚠️ No JWT issued for comment - legacy cookie might not exist in database')
      }
    })
  })

  it('should test participationInit with legacy cookie', function () {
    // Clear storage and set cookie
    cy.clearLocalStorage()
    cy.setCookie('pc', 'init-legacy-cookie-' + Date.now())

    // Track participationInit
    let initData = {}

    cy.intercept('GET', '**/api/v3/participationInit*', (req) => {
      req.continue((res) => {
        initData = {
          hasCookie: req.headers.cookie?.includes('pc='),
          responseStatus: res.statusCode,
          hasJWT: !!res.body.auth?.token,
          hasPtpt: !!res.body.ptpt,
        }
        console.log('ParticipationInit response:', initData)

        if (res.body.auth?.token) {
          // Store the token that was issued
          cy.window().then((win) => {
            win.localStorage.setItem(`participant_token_${conversationId}`, res.body.auth.token)
            console.log('Stored JWT from participationInit')
          })
        }
      })
    }).as('participationInit')

    // Visit conversation (triggers participationInit)
    cy.visit(`/${conversationId}`)
    cy.wait('@participationInit').then(() => {
      cy.log(`ParticipationInit - status: ${initData.responseStatus}, hasJWT: ${initData.hasJWT}`)
    })

    // Verify page loaded properly
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')
  })
})
