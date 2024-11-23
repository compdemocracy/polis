import { authenticateUser } from './helpers/api/auth.js'
import { createComment } from './helpers/data/comment.js'
import { createConversation } from './helpers/data/conversation.js'
import { dbHas } from './helpers/database/queries.js'

describe('Database Setup', () => {
  it('should successfully create and query test data', async () => {
    // First create a user via API
    const { user } = await authenticateUser()

    // Create conversation with the user as owner
    const conversation = await createConversation({
      owner: user.uid,
    })

    // Create comment using the same user
    const comment = await createComment({
      zid: conversation.zid,
      uid: user.uid,
      txt: 'Test comment',
    })

    expect(comment.zid).toBe(conversation.zid)
    expect(comment.txt).toBe('Test comment')
    expect(comment.uid).toBe(user.uid)
  })

  it('should properly reset database between tests', async () => {
    expect(await dbHas.user({ username: 'testuser' })).toBe(false)
  })
})
