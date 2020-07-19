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
    const existingEmail = this.user.email
    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(existingEmail)
    cy.contains('button', 'Send password reset email').click()

    cy.visit(`${Cypress.config().baseUrl}:${EMAIL_PORT}/`)
    cy.get('a.email-item').first().within(() => {
      cy.get('.title').should('contain', 'Polis Password Reset')
      cy.get('.subline').should('contain', existingEmail)
      cy.root().click()
    })
    // Has password reset link with proper hostname.
    cy.get('.email-content').should('contain', `${Cypress.config().baseUrl}/pwreset/`)
  })
})
