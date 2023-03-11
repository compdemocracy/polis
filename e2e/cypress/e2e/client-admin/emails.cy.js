import { generateRandomUser } from '../../support/helpers'

describe('Emails', function () {
  beforeEach(function () {
    cy.intercept('POST', '/api/v3/auth/pwresettoken').as('resetPassword')
    cy.intercept('POST', '/api/v3/auth/password').as('newPassword')
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
    const user = generateRandomUser()

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
      cy.wrap(email).as('email')
    })

    cy.get('@email').then((email) => {
      expect(email).to.have.property('to')
      expect(email.to).to.be.an('array')
      expect(email.to).to.have.length(1)
      expect(email.to[0]).to.have.property('address', user.email)

      expect(email).to.have.property('text')
      expect(email.text).to.include('reset your password')
      expect(email.text).to.include(Cypress.config('baseUrl') + '/pwreset/')
    })

    cy.get('@email').then((email) => {
      const regex = /https?:\/\/[^\s]+/
      const [resetUrl] = email.text.match(regex)
      cy.visit(resetUrl)
    })

    cy.get('input[type="password"]').first().type('new-password')
    cy.get('input[type="password"]').eq(1).type('new-password')
    cy.get('button').contains('Set new password').click()

    cy.wait('@newPassword').its('response.statusCode').should('eq', 200)

    cy.login({ ...user, password: 'new-password' })

    cy.location('pathname').should('eq', '/')
    cy.contains('h3', 'All Conversations').should('be.visible')
    cy.contains('a[href="/signout"]', 'sign out').should('be.visible')

    cy.getCookie('token2').should('exist')
    cy.getCookie('uid2').should('exist')
  })
})
