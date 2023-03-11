describe('Routes', function () {
  before(function () {
    cy.ensureConversation().then(() => {
      cy.wrap(`/m/${this.convoId}`).as('adminPath')
    })
  })

  beforeEach(function () {
    cy.ensureUser('moderator')
    cy.intercept('/api/v3/conversations*').as('getConversations')
    cy.intercept('/api/v3/users*').as('getUsers')
  })

  it('Page renders without trailing slash for /m/:id', function () {
    cy.visit(this.adminPath)
    cy.wait('@getConversations')

    cy.location('pathname').should('not.match', /\/$/)
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page strips trailing slash from /m/:id/', function () {
    cy.visit(this.adminPath + '/')
    cy.wait('@getConversations')

    cy.location('pathname').should('eq', this.adminPath)
    cy.get('h3').should('have.text', 'Configure')
  })

  it('Page strips trailing slash from /m/:id/share/', function () {
    const sharePath = this.adminPath + '/share'
    cy.visit(sharePath + '/')
    cy.wait('@getConversations')

    cy.location('pathname').should('eq', sharePath)
    cy.get('h3').should('have.text', 'Distribute')
  })

  it('Page strips trailing slash from /m/:id/comments/accepted/', function () {
    const moderatePath = this.adminPath + '/comments/accepted'
    cy.visit(moderatePath + '/')
    cy.wait('@getConversations')

    cy.location('pathname').should('eq', moderatePath)
    cy.get('h3').should('have.text', 'Moderate')
  })

  it('Page strips trailing slash from /account/', function () {
    const accountPath = '/account'
    cy.visit(accountPath + '/')
    cy.wait('@getUsers')

    cy.location('pathname').should('eq', accountPath)
    cy.get('h3').should('have.text', 'Account')
  })
})
