describe('Emails', function () {
  beforeEach(function () {
    cy.intercept('POST', '/api/v3/auth/pwresettoken').as('resetPassword')
  })

  it('sends for failed password reset', function () {
    const nonExistingEmail = 'idontexist@polis.test'

    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(nonExistingEmail)
    cy.get('button').contains('Send password reset email').click()

    cy.wait('@resetPassword').its('response.statusCode').should('eq', 200)
    cy.location('pathname').should('eq', '/pwresetinit/done')

    cy.request(Cypress.env('maildevUrl') + '/email').then((response) => {
      expect(response.status).to.eq(200)
      const [email] = response.body.slice(-1)

      cy.wrap(email)
        .should('have.property', 'to')
        .and('be.an', 'array')
        .and('have.length', 1)
        .then(([toObject]) => {
          expect(toObject).to.have.property('address', nonExistingEmail)
        })
    })
  })

  it('sends for successful password reset', function () {
    const user = {
      name: 'Password User',
      email: 'pwreset@polis.test',
      password: 'original-password',
    }

    cy.register(user)
    cy.logout()

    cy.visit('/pwresetinit')
    cy.get('input[placeholder="email"]').type(user.email)
    cy.get('button').contains('Send password reset email').click()

    cy.wait('@resetPassword').its('response.statusCode').should('eq', 200)
    cy.location('pathname').should('eq', '/pwresetinit/done')

    cy.request(Cypress.env('maildevUrl') + '/email').then((response) => {
      expect(response.status).to.eq(200)
      const [email] = response.body.slice(-1)

      cy.wrap(email)
        .should('have.property', 'text')
        .and('include', 'reset your password')
        .and('include', Cypress.config('baseUrl') + '/pwreset/')
        .should('have.property', 'to')
        .and('be.an', 'array')
        .and('have.length', 1)
        .then(([toObject]) => {
          expect(toObject).to.have.property('address', user.email)
        })
    })
  })
})
