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
      cy.get('input#createUserNameInput').type(this.user.name)
      cy.get('input#createUserEmailInput').type(this.user.email)
      cy.get('input#createUserPasswordInput').type(this.user.password)
      cy.get('input#createUserPasswordRepeatInput').type(this.user.password)

      cy.get('button#createUserButton').click()
    })

    // Attempt to recreate user.
    cy.visit('/createuser')
    cy.get('form').within(function () {
      cy.get('input#createUserNameInput').type(this.user.name)
      cy.get('input#createUserEmailInput').type(this.user.email)
      cy.get('input#createUserPasswordInput').type(this.user.password)
      cy.get('input#createUserPasswordRepeatInput').type(this.user.password)

      cy.get('button#createUserButton').click()
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
      cy.get('input#createUserNameInput').type(newUser.name)
      cy.get('input#createUserEmailInput').type(newUser.email)
      cy.get('input#createUserPasswordInput').type(newUser.password)
      cy.get('input#createUserPasswordRepeatInput').type(newUser.password)

      cy.get('button#createUserButton').click()

      const xhr = await cy.wait('@authNew')
      expect(xhr.status).to.equal(200)

      cy.url().should('eq', Cypress.config().baseUrl + '/')
    })
  })
})
