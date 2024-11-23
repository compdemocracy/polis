import { containerState } from '../../config/test-context.js'

export const apiRequests = {
  createConversation: async (token, data = {}) => {
    const request = containerState.getRequest()
    return request
      .post('/api/v3/conversations')
      .set('x-polis-token', token)
      .set('Content-Type', 'application/json')
      .send(data)
  },

  getComments: async (token, conversationId, params = {}) => {
    const request = containerState.getRequest()
    return (
      request
        .get('/api/v3/comments')
        // Use x-polis-token header instead of Bearer auth
        .set('x-polis-token', token)
        .query({
          conversation_id: conversationId,
          ...params,
        })
    )
  },

  createComment: async (token, data) => {
    const request = containerState.getRequest()
    return request
      .post('/api/v3/comments')
      .set('x-polis-token', token)
      .send(data)
  },

  createCommentUnauthenticated: async (data) => {
    const request = containerState.getRequest()
    return request.post('/api/v3/comments').send(data)
  },

  createVote: async (token, data) => {
    const request = containerState.getRequest()
    return request
      .post('/api/v3/votes')
      .set('x-polis-token', token)
      .send({
        pid: 'mypid', // Use special 'mypid' value instead of numeric pid
        ...data,
      })
  },

  getVotes: async (token, conversationId, params = {}) => {
    const request = containerState.getRequest()
    return request
      .get('/api/v3/votes')
      .set('x-polis-token', token)
      .query({
        conversation_id: conversationId,
        ...params,
      })
  },

  // Add more API helpers as needed
}
