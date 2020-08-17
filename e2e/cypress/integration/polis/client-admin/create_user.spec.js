describe('Create User page', () => {
  before(() => {
    cy.fixture('users.json').as('users')
  })

  beforeEach(() => {
    const [name, email, password] = ['Dummy', 'test@polis.test', 'testpassword']

    cy.server()
    cy.route({
      method: 'POST',
      url: Cypress.config().apiPath + '/auth/new'
    }).as('authNew')

    cy.visit('/createuser')

    cy.get('input#createUserNameInput').type(name)
    cy.get('input#createUserEmailInput').type(email)
    cy.get('input#createUserPasswordInput').type(password)
    cy.get('input#createUserPasswordRepeatInput').type(password)
  })

  it('does not create a new user with existing email address', function () {
    const existingUser = this.users.moderator

    // Attempt to recreate existing user.
    cy.get('input#createUserEmailInput').clear().type(existingUser.email)
    cy.get('button#createUserButton').click()

    cy.wait('@authNew').then(xhr => {
      console.log(xhr)
      cy.wrap(xhr).its('status').should('eq', 403)
      cy.wrap(xhr).its('response.body').should('eq', 'polis_err_reg_user_with_that_email_exists')
    })
    cy.contains('form', 'Email address already in use')
    cy.location('pathname').should('eq', '/createuser')
  })

  it('creates a new user', function () {
    const randomInt = Math.floor(Math.random() * 10000)
    const newUser = {
      email: `user${randomInt}@polis.test`
    }

    cy.get('input#createUserEmailInput').clear().type(newUser.email)
    cy.get('button#createUserButton').click()

    cy.wait('@authNew').its('status').should('eq', 200)
    cy.location('pathname').should('eq', '/')
  })
})
