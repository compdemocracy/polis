describe('Database Seeding', function () {
  let moderator
  let convoIds = []
  let completedVoters = 0

  before(function () {
    moderator = {
      name: 'Test Moderator',
      email: 'moderator@polis.test',
      password: 'Te$tP@ssw0rd*',
    }
  })

  it('creates moderator and conversations', function () {
    cy.register(moderator)

    const numConversations = Cypress.env('numConversations') || 2
    const commentsPerConvo = Cypress.env('commentsPerConvo') || 3

    // Create conversations and store their IDs
    for (let i = 0; i < numConversations; i++) {
      const topic = `Test Conversation ${i + 1}`
      const description = `This is a test conversation ${i + 1} created by the seeding script`

      cy.createConvo(topic, description, moderator).then(function () {
        const convoId = this.convoId
        convoIds.push(convoId)

        // Add seed comments
        for (let j = 0; j < commentsPerConvo; j++) {
          cy.seedComment(convoId)
        }
      })
    }

    cy.clearCookie('token2')
    cy.clearCookie('uid2')
  })

  it('adds votes from participants', function () {
    const numVoters = Cypress.env('numVoters') || 5
    const batchSize = 20 // Process participants in batches to manage memory
    const totalBatches = Math.ceil(numVoters / batchSize)

    // Process participants in batches
    for (let batchStart = 0; batchStart < numVoters; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, numVoters)
      const currentBatch = Math.floor(batchStart / batchSize) + 1

      // For each participant in this batch
      for (let i = batchStart; i < batchEnd; i++) {
        const participantId = `participant_${i}`
        const xid = `seed-${i + 1}`

        // Vote on all conversations as this participant
        convoIds.forEach((convoId) => {
          cy.session(
            participantId,
            () => {
              cy.voteOnConversation(convoId, xid)
            },
            {
              validate: () => {
                cy.getCookie('pc').should('exist')
              },
              cacheAcrossSpecs: false,
            },
          )
        })

        // Track progress
        completedVoters++

        // Clean up after each participant
        cy.clearAllCookies()
        cy.clearAllSessionStorage()
        cy.clearAllLocalStorage()
      }

      // After each batch
      Cypress.session.clearAllSavedSessions()

      // Small delay between batches to allow for GC
      if (currentBatch < totalBatches) {
        // eslint-disable-next-line cypress/no-unnecessary-waiting
        cy.wait(1000)
      }
    }

    // Final progress report
    cy.log('Seeding Complete:')
    cy.log(`- Total voters processed: ${completedVoters}`)
    cy.log(`- Total conversations: ${convoIds.length}`)
    cy.log(`- Comments per conversation: ${Cypress.env('commentsPerConvo') || 3}`)
  })
})
