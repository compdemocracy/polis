describe('Create User', () => {
  afterEach(() => cy.visit('/signout'))

  beforeEach(() => {
    cy.visit('/signout')
    cy.visit('/createuser')
  })

  before(async function () {
    const users = await cy.fixture('users')
    this.user = users[0]
  })

  it('Does not create a new user with existing email address', () => {
    // Create user.
    cy.get('form').within(function () {
      cy.get('input[placeholder=name]').type(this.user.name)
      cy.get('input[placeholder=email]').type(this.user.email)
      cy.get('input[placeholder=password]').type(this.user.password)
      cy.get('input[placeholder="repeat password"]').type(this.user.password)

      cy.get('button').click()
    })

    // Attempt to recreate user.
    cy.visit('/createuser')
    cy.get('form').within(function () {
      cy.get('input[placeholder=name]').type(this.user.name)
      cy.get('input[placeholder=email]').type(this.user.email)
      cy.get('input[placeholder=password]').type(this.user.password)
      cy.get('input[placeholder="repeat password"]').type(this.user.password)

      cy.get('button').click()
    })

    cy.get('form').contains(
      'Email address already in use, Try logging in instead.'
    )
    cy.url().should('eq', Cypress.config().baseUrl + '/createuser')
  })

  it('Creates a new user', () => {
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

    cy.get('form').within(async function () {
      cy.get('input[placeholder=name]').type(newUser.name)
      cy.get('input[placeholder=email]').type(newUser.email)
      cy.get('input[placeholder=password]').type(newUser.password)
      cy.get('input[placeholder="repeat password"]').type(newUser.password)

      cy.get('button').click()

      const xhr = await cy.wait('@authNew')
      expect(xhr.status).to.equal(200)

      cy.url().should('eq', Cypress.config().baseUrl + '/')
    })
  })
})
