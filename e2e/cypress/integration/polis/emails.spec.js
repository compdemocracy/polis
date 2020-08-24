describe('Emails', () => {
  const MAILDEV_HTTP_PORT = '1080'
  // See: https://github.com/maildev/maildev/blob/master/docs/rest.md
  // Maildev only available over HTTP, even if using SSL for app.
  const MAILDEV_API_BASE = `${Cypress.config().baseUrl}:${MAILDEV_HTTP_PORT}`.replace('https://', 'http://')

  beforeEach(() => {
    cy.server()
    cy.route('POST', Cypress.config().apiPath + '/auth/pwresettoken').as('resetPassword')

    cy.request('DELETE', MAILDEV_API_BASE + '/email/all')
  })

  it('sends for failed password reset', function () {
    const nonExistingEmail = 'nonexistent@polis.test'
    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(nonExistingEmail)
    cy.contains('button', 'Send password reset email').click()
    cy.wait('@resetPassword').its('status').should('eq', 200)
    cy.location('pathname').should('eq', '/pwresetinit/done')

    cy.request('GET', MAILDEV_API_BASE + '/email')
      .then(resp => {
        const email = resp.body.shift()
        console.log(email)
        cy.wrap(email).its('subject').should('contain', 'Password Reset Failed')
        cy.wrap(email).its('to').its(0).its('address').should('contain', nonExistingEmail)
      })
  })

  it('sends for successful password reset', function () {
    // Create a new user account, so we can actually change password.
    const randomInt = Math.floor(Math.random() * 10000)
    const newUser = {
      email: `user${randomInt}@polis.test`,
      name: `Test User ${randomInt}`,
      password: 'testpassword',
      newPassword: 'newpassword',
    }

    const strictFail = true
    cy.signup(newUser.name, newUser.email, newUser.password, strictFail)

    cy.logout()

    // Request password reset on new account
    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(newUser.email)
    cy.contains('button', 'Send password reset email').click()
    cy.wait('@resetPassword').its('status').should('eq', 200)
    cy.location('pathname').should('eq', '/pwresetinit/done')

    cy.request('GET', MAILDEV_API_BASE + '/email')
      .then(resp => {
        const email = resp.body.shift()
        cy.wrap(email).its('subject').should('contain', 'Polis Password Reset')
        cy.wrap(email).its('to').its(0).its('address').should('contain', newUser.email)

        // Has password reset link with proper hostname.
        cy.wrap(email).its('text').should('contain', `${Cypress.config().baseUrl}/pwreset/`)

        const emailContent = email.text
        console.log(email)
        const tokenRegex = new RegExp('/pwreset/([a-zA-Z0-9]+)\n', 'g')
        const match = tokenRegex.exec(emailContent)
        // First "url" is email domain. Second url is the one we want.
        cy.log(JSON.stringify(match))
        const passwordResetToken = match[1]

        // Submit password reset form with new password.
        cy.visit(`/pwreset/${passwordResetToken}`)

        cy.route('POST', Cypress.config().apiPath + '/auth/password').as('newPassword')

        cy.get('form').within(() => {
          cy.get('input[placeholder="new password"]').type(newUser.newPassword)
          cy.get('input[placeholder="repeat new password"]').type(newUser.newPassword)
          cy.get('button').click()
        })

        cy.wait('@newPassword').then((xhr) => {
          expect(xhr.status).to.equal(200)
        })
      })

    cy.logout()

    // Login with new password.
    cy.login(newUser.email, newUser.newPassword)

    cy.url().should('eq', Cypress.config().baseUrl + '/')
  })

  // TODO: Re-enabled account verification.
  it.skip('sends when new account requires verification', function () {
  })

  // TODO: Allow batch interval to be skipped or reduced for tests.
  it.skip('sends when new statements arrive', function () {
  })

  // TODO: Fix data export.
  it.skip('sends when data export is run', function () {
  })

  // TODO: Find way to test embedded iframe.
  it.skip('sends when new conversation is auto-created', function () {
  })
  
  it.skip('sends when new statement available for moderation', function () {
  })
})
