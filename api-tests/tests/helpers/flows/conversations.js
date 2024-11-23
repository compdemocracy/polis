import { apiRequests } from '../api/requests.js'
import { authenticateUser } from '../api/auth.js'

export async function setupConversation(overrides = {}) {
  const { token } = await authenticateUser()
  const conversationResponse = await apiRequests.createConversation(token, {
    topic: 'Test Conversation',
    description: 'A conversation for testing',
    ...overrides,
  })
  return {
    token,
    conversation_id: conversationResponse.body.conversation_id,
  }
}
