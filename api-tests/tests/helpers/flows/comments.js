import { apiRequests } from '../api/requests.js'
import { authenticateUser } from '../api/auth.js'

export async function setupUserWithComment(overrides = {}) {
  const { token } = await authenticateUser()

  const conversationResponse = await apiRequests.createConversation(token, {
    topic: 'Test Conversation',
    description: 'A conversation for testing',
  })
  const conversation_id = conversationResponse.body.conversation_id

  const commentResponse = await apiRequests.createComment(token, {
    conversation_id,
    txt: 'Test comment',
    ...overrides,
  })

  return {
    token,
    conversation_id,
    tid: commentResponse.body.tid,
    currentPid: commentResponse.body.currentPid,
  }
}
