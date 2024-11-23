import { authenticateUser } from '../helpers/api/auth.js'
import { apiRequests } from '../helpers/api/requests.js'

describe('Conversations API', () => {
  it('should create a new conversation', async () => {
    // Arrange: Authenticate a user and get a token
    const { token } = await authenticateUser()

    // Arrange: Define conversation data
    const conversationData = {
      topic: 'Test Conversation',
      description: 'This is a test conversation.',
      is_active: true,
      is_draft: false,
      is_public: true,
      is_anon: false,
      profanity_filter: true,
      spam_filter: true,
      strict_moderation: false,
      auth_needed_to_vote: false,
      auth_needed_to_write: false,
      auth_opt_fb: true,
      auth_opt_tw: true,
      auth_opt_allow_3rdparty: true,
      owner_sees_participation_stats: false,
    }

    // Act: Call the API to create a new conversation
    const response = await apiRequests.createConversation(
      token,
      conversationData
    )

    // Assert: Verify the response
    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('conversation_id')
    expect(response.body).toHaveProperty('url')
  })

  it.skip('should get conversations recently started', async () => {
    // Arrange: Ensure there are some recently started conversations
    // Act: Call the API endpoint to get recently started conversations
    // Assert: Verify the response contains the expected conversations
  })

  it.skip('should get conversations recent activity', async () => {
    // Arrange: Ensure there are conversations with recent activity
    // Act: Call the API endpoint to get conversations with recent activity
    // Assert: Verify the response contains the expected conversations
  })

  it.skip('should subscribe to a conversation', async () => {
    // Arrange: Prepare a conversation and a user to subscribe
    // Act: Call the API endpoint to subscribe the user to the conversation
    // Assert: Verify the subscription was successful
  })

  it.skip('should unsubscribe from a conversation', async () => {
    // Arrange: Ensure the user is subscribed to a conversation
    // Act: Call the API endpoint to unsubscribe the user
    // Assert: Verify the unsubscription was successful
  })

  it.skip('should close a conversation', async () => {
    // Arrange: Prepare an active conversation
    // Act: Call the API endpoint to close the conversation
    // Assert: Verify the conversation is marked as inactive
  })

  it.skip('should reopen a conversation', async () => {
    // Arrange: Prepare a closed conversation
    // Act: Call the API endpoint to reopen the conversation
    // Assert: Verify the conversation is marked as active
  })

  it.skip('should update conversation details', async () => {
    // Arrange: Prepare a conversation with initial details
    // Act: Call the API endpoint to update the conversation details
    // Assert: Verify the details are updated correctly
  })

  it.skip('should retrieve conversation statistics', async () => {
    // Arrange: Ensure there are statistics available for a conversation
    // Act: Call the API endpoint to get conversation statistics
    // Assert: Verify the statistics are returned correctly
  })

  it.skip('should reserve a conversation ID', async () => {
    // Arrange: Prepare necessary data for reserving an ID
    // Act: Call the API endpoint to reserve a conversation ID
    // Assert: Verify the ID is reserved successfully
  })

  // Additional tests can be added here to cover more scenarios
})
