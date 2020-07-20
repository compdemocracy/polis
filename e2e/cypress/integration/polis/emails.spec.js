describe('Emails', () => {
  const EMAIL_PORT = '1080'

  beforeEach(() => {
    cy.visit(`${Cypress.config().baseUrl}:${EMAIL_PORT}`)
    cy.contains('Clear Inbox').click()
    cy.contains('Now receiving all emails')

    cy.fixture('users.json').then((users) => {
      cy.wrap(users[0]).as('user')
    })
  })

  it('sends for failed password reset', function () {
    const nonExistingEmail = 'nonexistent@polis.test'
    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(nonExistingEmail)
    cy.contains('button', 'Send password reset email').click()

    cy.visit(`${Cypress.config().baseUrl}:${EMAIL_PORT}/`)
    cy.get('a.email-item').first().within(() => {
      cy.get('.title').should('contain', 'Password Reset Failed')
      cy.get('.subline').should('contain', nonExistingEmail)
    })
  })

  it('sends for successful password reset', function () {
    // Create a new user account
    const randomInt = Math.floor(Math.random() * 10000)
    const newUser = {
      email: `user${randomInt}@polis.test`,
      name: `Test User ${randomInt}`,
      password: 'testpassword',
      newPassword: 'newpassword',
    }

    cy.server()
    cy.route({
      method: 'POST',
      url: Cypress.config().apiPath + '/auth/new'
    }).as('authNew')

    cy.signup(newUser.name, newUser.email, newUser.password)

    cy.wait('@authNew').then((xhr) => {
      expect(xhr.status).to.equal(200)
    })

    cy.logout()

    // Request password reset on new account
    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(newUser.email)
    cy.contains('button', 'Send password reset email').click()

    cy.visit(`${Cypress.config().baseUrl}:${EMAIL_PORT}/`)
    cy.get('a.email-item').first().within(() => {
      cy.get('.title').should('contain', 'Polis Password Reset')
      cy.get('.subline').should('contain', newUser.email)
      cy.root().click()
    })
    // Has password reset link with proper hostname.
    cy.get('.email-content').should('contain', `${Cypress.config().baseUrl}/pwreset/`)
    cy.get('.email-content').then(($elem) => {
      const emailContent = $elem.text()
      const tokenRegex = new RegExp('/pwreset/([a-zA-Z0-9]+)\n', 'g')
      const match = tokenRegex.exec(emailContent)
      // First "url" is email domain. Second url is the one we want.
      cy.log(JSON.stringify(match))
      const passwordResetToken = match[1]

      // Submit password reset form with new password.
      cy.visit(`/pwreset/${passwordResetToken}`)

      cy.route({
        method: 'POST',
        url: Cypress.config().apiPath + '/auth/password'
      }).as('authPassword')

      cy.get('form').within(() => {
        cy.get('input[placeholder="new password"]').type(newUser.newPassword)
        cy.get('input[placeholder="repeat new password"]').type(newUser.newPassword)
        cy.get('button').click()
      })

      cy.wait('@authPassword').then((xhr) => {
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
