describe('Conversation: Configure', function () {
  beforeEach(function () {
    cy.intercept('GET', '/api/v3/conversations*').as('getConversations')
    cy.intercept('GET', '/api/v3/users*').as('getUsers')
    cy.intercept('GET', '/api/v3/participationInit*').as('participationInit')
    cy.intercept('POST', '/api/v3/comments').as('createComment')
    cy.intercept('POST', '/api/v3/conversations').as('createConversation')
    cy.intercept('PUT', '/api/v3/conversations').as('updateConversation')
  })

  describe('Create new conversation', function () {
    beforeEach(function () {
      return cy.ensureUser('moderator')
    })

    it('should create with proper defaults', function () {
      cy.createConvo().then(() => cy.visit('/m/' + this.convoId))
      cy.wait('@getUsers')
      cy.wait('@getConversations')

      // Customize section
      cy.get('input[data-test-id="vis_type"]').should('not.be.checked')
      cy.get('input[data-test-id="write_type"]').should('be.checked')
      cy.get('input[data-test-id="help_type"]').should('be.checked')
      cy.get('input[data-test-id="subscribe_type"]').should('be.checked')

      // Schemes section
      cy.get('input[data-test-id="is_active"]').should('be.checked')
      cy.get('input[data-test-id="strict_moderation"]').should('not.be.checked')
    })

    it('should create a new conversation with a topic and description', function () {
      cy.visit('/')
      cy.contains('button', 'Create new conversation').click()

      cy.wait('@createConversation').then(({ response }) =>
        cy.location('pathname').should('eq', '/m/' + response.body.conversation_id),
      )

      cy.contains('h3', 'Configure').should('be.visible')

      cy.get('input[data-test-id="topic"]').type('Test topic')

      cy.get('input[data-test-id="topic"]').then(() => cy.focused().blur())

      cy.wait('@updateConversation').then(({ response }) =>
        expect(response.body.topic).to.equal('Test topic'),
      )

      cy.get('textarea[data-test-id="description"]').type('Test description')

      cy.get('textarea[data-test-id="description"]').then(() => cy.focused().blur())

      cy.wait('@updateConversation').then(({ response }) =>
        expect(response.body.description).to.equal('Test description'),
      )

      cy.get('textarea[data-test-id="seed_form"]').type('Test seed comment')
      cy.get('button').contains('Submit').click()

      cy.wait('@createComment').its('response.statusCode').should('eq', 200)

      cy.get('button').contains('Success!').should('be.visible')
    })
  })

  describe('Conversation Participation', function () {
    beforeEach(function () {
      cy.createConvo().then(() => {
        cy.visit('/m/' + this.convoId)
        cy.wait('@getConversations')
        cy.get('input[data-test-id="topic"]').type('Participation Test Topic')
        cy.get('textarea[data-test-id="description"]').type('Test description')
        cy.get('textarea[data-test-id="seed_form"]').type('Initial seed comment')
        cy.get('button').contains('Submit').click()
      })
    })

    it('should allow multiple seed comments', function () {
      cy.wait('@createComment', { timeout: 7000 })
      cy.get('textarea[data-test-id="seed_form"]').clear()
      cy.get('textarea[data-test-id="seed_form"]').type('Second seed comment')
      // pause for 1 second to ensure the button is in correct state
      cy.pause()

      cy.get('button').contains('Submit').click()
      cy.wait('@createComment', { timeout: 7000 })
      cy.get('textarea[data-test-id="seed_form"]').clear()
      cy.get('textarea[data-test-id="seed_form"]').type('third seed comment')
      // pause for 1 second to ensure the button is in correct state
      cy.pause()

      cy.get('button').contains('Submit').click()
      cy.wait('@createComment', { timeout: 7000 })

      // Verify all seed comments are visible by checking API response
      cy.request(`/api/v3/comments?conversation_id=${this.convoId}`).then((response) =>
        expect(response.body.length).to.equal(3),
      )
    })

    it('should handle special characters in topic and description', function () {
      const specialTopic = 'Test & Topic with $pecial <characters>'
      const specialDesc = '!@#$%^&*() Special description 你好'

      cy.get('input[data-test-id="topic"]').clear().type(specialTopic)
      cy.get('input[data-test-id="topic"]').then(() => cy.focused().blur())
      cy.wait('@updateConversation')

      cy.get('textarea[data-test-id="description"]').clear().type(specialDesc)
      cy.get('textarea[data-test-id="description"]').then(() => cy.focused().blur())
      cy.wait('@updateConversation')

      // Verify the content is saved correctly
      cy.reload()
      cy.get('input[data-test-id="topic"]').should('have.value', specialTopic)
      cy.get('textarea[data-test-id="description"]').should('have.value', specialDesc)
    })
  })

  describe('Conversation Settings', function () {
    beforeEach(function () {
      cy.createConvo().then(() => cy.visit('/m/' + this.convoId))
      cy.wait('@getConversations')
    })

    it('should toggle visibility settings correctly', function () {
      cy.get('input[data-test-id="vis_type"]').check()
      cy.wait('@updateConversation').then(({ response }) => {
        expect(response.body.is_public).to.be.true
      })
    })
  })

  describe('Closing a Conversation', function () {
    beforeEach(function () {
      cy.createConvo().then(() => cy.visit('/m/' + this.convoId))
      cy.wait('@getConversations')
      cy.get('input[data-test-id="topic"]').type('Test topic')
      cy.get('button').contains('Submit').click()
      cy.get('input[data-test-id="is_active"]').uncheck()
    })

    it('responds properly to being closed', function () {
      cy.ensureUser()
      cy.visit('/' + this.convoId)
      cy.wait('@participationInit')

      cy.get('[data-view-name="participationView"]').should('be.visible')
      cy.get('h2').contains('Test topic closed').should('be.visible')
    })
  })
})
