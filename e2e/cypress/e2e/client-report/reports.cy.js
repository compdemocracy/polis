describe('Reports', function () {
  beforeEach(function () {
    // Disable matrix functionality to avoid assertExists errors
    cy.intercept('GET', '/api/v3/math/pca2*', {
      statusCode: 200,
      body: {
        'base-clusters': [],
        consensus: {},
        'group-aware-consensus': {},
        'group-clusters': [],
        'group-votes': [],
        'n-cmts': 0,
        'user-vote-counts': [],
        'votes-base': [],
        center: [],
        'comment-extremity': [],
        'comment-projection': [],
        comps: [],
        repness: [],
        tids: [],
        pca: {
          center: [],
          'comment-extremity': [],
          'comment-projection': [],
          comps: [],
        },
      }, // or minimal math data structure if needed
    }).as('getMath')
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/reports*').as('getReports')
    cy.intercept('GET', '/api/v3/comments*').as('getComments')

    cy.createConvo().then(() => {
      cy.visit('/m/' + this.convoId)
      cy.wait('@getConversations')
      cy.visit('/m/' + this.convoId + '/reports')
    })
  })

  describe('Reports List', function () {
    it('should create a report URL and show link', function () {
      // pause for ten seconds to allow the button to be visible
      cy.pause()
      cy.contains('button', 'Create report url').click()
      cy.get('a[href*="/report/"]').then(($link) => {
        cy.visit($link.attr('href'))
        cy.get('[data-testid="reports-overview"]').should('exist')
      })
    })
  })
})
