describe('Database Seeding', function () {
  let moderator
  let conversationIds = []

  before(function () {
    moderator = {
      name: 'Test Moderator',
      email: 'moderator@polis.test',
      password: 'Te$tP@ssw0rd*'
    }
  })

  it('creates moderator and conversations', function () {
    // Register moderator
    cy.register(moderator)

    const numConversations = Cypress.env('numConversations') || 2
    const commentsPerConvo = Cypress.env('commentsPerConvo') || 3

    // Create a session for our moderator
    cy.session(
      'generated_moderator',
      () => {
        cy.loginViaAPI(moderator)
      },
      {
        validate: () => {
          cy.getCookie('token2').should('exist')
          cy.getCookie('uid2').should('exist')
        }
      }
    )

    // Create conversations and store their IDs
    for (let i = 0; i < numConversations; i++) {
      const topic = `Test Conversation ${i + 1}`
      const description = `This is a test conversation ${i + 1} created by the seeding script`

      cy.createConvo(topic, description).then(function () {
        const convoId = this.convoId
        conversationIds.push(convoId)

        // Add seed comments
        for (let j = 0; j < commentsPerConvo; j++) {
          cy.seedComment(convoId)
        }
      })
    }

    cy.logout()
  })

  it('adds votes from participants', function () {
    const numParticipants = Cypress.env('numVoters') || 5

    // For each participant
    for (let i = 0; i < numParticipants; i++) {
      // Create a unique session for this participant
      cy.session(
        `participant_${i}`,
        () => {
          // Initialize participant with first conversation
          cy.request(
            '/api/v3/participationInit?conversation_id=' + conversationIds[0] + '&pid=mypid&lang=acceptLang'
          )
        }
      )

      // Visit and vote on all conversations
      conversationIds.forEach(conversationId => {
        cy.visitAndVote(conversationId)
      })
    }
  })
})