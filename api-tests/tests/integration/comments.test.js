import { authenticateUser } from '../helpers/api/auth.js'
import { apiRequests } from '../helpers/api/requests.js'
import { setupUserWithComment } from '../helpers/flows/comments.js'
import { dbFind } from '../helpers/database/queries.js'
import { setupConversation } from '../helpers/flows/conversations.js'
import { dbValidate } from '../helpers/database/queries.js'

describe('Comments API', () => {
  describe('GET /api/v3/comments', () => {
    it('should fetch comments for a conversation', async () => {
      const { token, conversation_id } = await setupConversation({
        topic: 'Test Conversation',
        description: 'A conversation for testing comments',
      })

      // Create a comment to fetch
      const commentResponse = await apiRequests.createComment(token, {
        conversation_id,
        txt: 'Test comment for fetching',
      })
      expect(commentResponse.status).toBe(200)

      const response = await apiRequests.getComments(token, conversation_id, {
        include_social: true,
        include_demographics: true,
      })

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should require valid conversation_id', async () => {
      // Setup authenticated user
      const { token } = await authenticateUser()

      // Attempt to fetch comments with invalid conversation_id
      const response = await apiRequests.getComments(token, 'invalid-id')

      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/v3/comments', () => {
    it('should create a new comment', async () => {
      const { token, conversation_id } = await setupConversation()
      const commentText = 'This is a test comment'

      const response = await apiRequests.createComment(token, {
        conversation_id,
        txt: commentText,
        vote: 1,
      })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('tid')
      expect(response.body).toHaveProperty('currentPid')

      const comment = await dbFind.commentByTid(response.body.tid)
      expect(comment.txt).toBe(commentText)
    })

    it('should handle anonymous comments', async () => {
      const { token, conversation_id } = await setupConversation()

      const response = await apiRequests.createComment(token, {
        conversation_id,
        txt: 'Anonymous comment',
        anon: true,
      })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('tid')

      const comment = await dbFind.commentByTid(response.body.tid)
      expect(comment.anon).toBe(true)
      expect(comment.txt).toBe('Anonymous comment')
    })

    it('should reject comments exceeding length limit', async () => {
      const { token, conversation_id } = await setupConversation()
      const longText = 'x'.repeat(998)

      const response = await apiRequests.createComment(token, {
        conversation_id,
        txt: longText,
      })

      expect(response.status).toBe(400)
      expect(dbValidate.commentLength(longText)).toBe(false)
    })

    it('should require authentication', async () => {
      // Setup test conversation using an authenticated user
      const { token } = await authenticateUser()
      const conversationResponse = await apiRequests.createConversation(token, {
        topic: 'Test Conversation',
      })
      const conversation_id = conversationResponse.body.conversation_id

      // Attempt to create comment without authentication
      const response = await apiRequests.createCommentUnauthenticated({
        conversation_id,
        txt: 'This should fail',
      })

      // TODO: This should be 401 but currently returns 500 due to unhandled auth error
      // See: polis_err_auth_error_432 and polis_err_auth_token_not_supplied
      expect(response.status).toBe(500)
    })
  })

  describe('Comment voting flow', () => {
    it('should allow creating and voting on comments', async () => {
      const { token, conversation_id, tid } = await setupUserWithComment()

      const voteResponse = await apiRequests.createVote(token, {
        conversation_id,
        tid,
        vote: 1,
      })
      expect(voteResponse.status).toBe(200)

      const vote = await dbFind.vote({ tid, conversation_id, token })
      expect(vote.vote).toBe(1)
    })
  })
})
