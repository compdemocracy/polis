import { generateRandomUser } from '../../support/helpers'

describe('Create User page', function () {
  it('should redirect unauthenticated user to signin page', function () {
    cy.visit('/account')
    cy.location('pathname').should('eq', '/signin')
  })
})
