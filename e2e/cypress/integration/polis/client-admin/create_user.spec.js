describe('Create User', () => {
  beforeEach(() => {
    // Cypress doesn't believe in cleanup.
    // See: https://docs.cypress.io/guides/references/best-practices.html#State-reset-should-go-before-each-test
    cy.logout()
  })

  before(() => {
    cy.fixture('users.json').as('users')
  })

  it('Does not create a new user with existing email address', function () {
    const user = this.users[0]

    // Create user.
    cy.signup(user.name, user.email, user.password)

    // Attempt to recreate user.
    cy.signup(user.name, user.email, user.password)

    cy.get('form').contains(
      'Email address already in use, Try logging in instead.'
    )
    cy.url().should('eq', Cypress.config().baseUrl + '/createuser')
  })

  it('Creates a new user', function () {
    const randomInt = Math.floor(Math.random() * 10000)
    const newUser = {
      email: `user${randomInt}@polis.test`,
      name: `Test User ${randomInt}`,
      password: 'testpassword'
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

    cy.url().should('eq', Cypress.config().baseUrl + '/')
  })
})
