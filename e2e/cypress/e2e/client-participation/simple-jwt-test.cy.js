/**
 * Simple test to debug JWT flow
 */

import { setupTestConversation } from '../../support/conversation-helpers.js'

describe('Simple JWT Debug', function () {
  let conversationId

  before(function () {
    setupTestConversation({
      topic: 'Simple JWT Test',
      description: 'Simple test',
      comments: ['Test comment'],
    }).then((result) => {
      conversationId = result.conversationId
    })
  })

  it('logs vote response without intercepts', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Wait for page to load
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // Add a spy to watch the react function being called
    cy.window().then((win) => {
      // Override XMLHttpRequest to log responses
      const originalXHR = win.XMLHttpRequest
      win.XMLHttpRequest = function () {
        const xhr = new originalXHR()
        const originalSend = xhr.send

        xhr.send = function (...args) {
          if (this._url && this._url.includes('/api/v3/votes')) {
            console.log('🗳️ Vote request being sent to:', this._url)

            const originalOnload = xhr.onload
            xhr.onload = function () {
              console.log('🗳️ Vote response received:')
              console.log('  Status:', xhr.status)
              console.log('  Response Text:', xhr.responseText)

              try {
                const response = JSON.parse(xhr.responseText)
                console.log('  Parsed Response:', response)

                if (response.auth && response.auth.token) {
                  console.log('  ✅ JWT found in response!')
                  console.log('  Token:', response.auth.token)
                } else {
                  console.log('  ❌ No JWT in response')
                  console.log('  Response keys:', Object.keys(response))
                }
              } catch (e) {
                console.log('  ❌ Failed to parse response:', e)
              }

              if (originalOnload) {
                originalOnload.apply(this, arguments)
              }
            }
          }

          return originalSend.apply(this, args)
        }

        // Store URL when open is called
        const originalOpen = xhr.open
        xhr.open = function (method, url, ...args) {
          xhr._url = url
          return originalOpen.apply(this, [method, url, ...args])
        }

        return xhr
      }
    })

    // Click vote button
    cy.get('#agreeButton').click()

    // Wait for response and check localStorage
    cy.wait(1000).then(() => {
      cy.window().then((win) => {
        console.log('📋 Final check:')
        console.log('  localStorage keys:', Object.keys(win.localStorage))
        const token = win.localStorage.getItem('participant_token')

        if (token) {
          console.log('  ✅ JWT found in localStorage!')
          expect(token).to.exist
        } else {
          console.log('  ❌ No JWT in localStorage')

          // Check if there were any errors
          console.log('  Checking for console errors...')
        }
      })
    })
  })

  it('logs vote with minimal intercept', function () {
    // Clear storage
    cy.clearLocalStorage()

    // Use a minimal intercept that just logs without modifying
    cy.intercept('POST', '/api/v3/votes', (req) => {
      req.on('response', (res) => {
        console.log('📡 Intercepted vote response:', {
          status: res.statusCode,
          body: res.body,
        })
      })
    }).as('vote')

    // Visit conversation
    cy.visit(`/${conversationId}`)

    // Wait for page to load
    cy.get('#agreeButton', { timeout: 10000 }).should('be.visible')

    // Click vote button
    cy.get('#agreeButton').click()

    // Wait for vote
    cy.wait('@vote')

    // Check localStorage
    cy.wait(1000).then(() => {
      cy.window().then((win) => {
        const token = win.localStorage.getItem('participant_token')
        if (token) {
          cy.log('✅ JWT stored successfully')
          expect(token).to.exist
        } else {
          throw new Error('JWT not found in localStorage after vote')
        }
      })
    })
  })
})
