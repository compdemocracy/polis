describe('Access control', function () {
  before(function () {
    cy.ensureUser('admin')
    cy.createConvo('Test Admin Conversation').then(() => {
      // Save the convo ID for later tests
      cy.wrap(this.convoId).as('ownerConvoId')
    })
  })

  beforeEach(function () {
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
  })

  describe('Admin users', function () {
    it('Can access admin pages for conversations they own', function () {
      cy.ensureUser('admin')
      cy.visit(`/m/${this.ownerConvoId}`)
      cy.get('#no-permission-warning').should('not.exist')
    })
  })

  describe('Regular users', function () {
    it('Cannot access admin pages for conversations they did not create', function () {
      // Use a different user who doesn't own the conversation
      cy.ensureUser('participant2')

      // Access the conversation created by admin user
      cy.visit(`/m/${this.ownerConvoId}`)

      cy.get('#no-permission-warning').should('exist').and('be.visible')
    })

    it('Can access the participation view', function () {
      cy.ensureUser('participant2')
      cy.visit(`/${this.ownerConvoId}`)
      cy.wait('@participationInit').its('response.statusCode').should('eq', 200)
      cy.get('[data-view-name="participationView"]').should('be.visible')
    })
  })

  describe('Anonymous users', function () {
    it('Cannot access admin pages, will be redirected to sign in', function () {
      // Clear cookies to become anonymous
      cy.clearCookies()

      // Intercept the API call that would detect unauthorized user
      cy.intercept('GET', '/api/v3/users*').as('getUsers')

      // Try to access admin page
      cy.visit(`/m/${this.ownerConvoId}`)

      // Should get 401 and redirect to signin
      cy.wait('@getUsers').its('response.statusCode').should('eq', 401)
      cy.location('pathname').should('eq', '/signin')
    })

    it('Can access the participation view', function () {
      // Clear cookies to become anonymous
      cy.clearCookies()

      // Try to access participation view
      cy.visit(`/${this.ownerConvoId}`)
      cy.wait('@participationInit').its('response.statusCode').should('eq', 200)
      cy.get('[data-view-name="participationView"]').should('be.visible')
    })
  })
})
