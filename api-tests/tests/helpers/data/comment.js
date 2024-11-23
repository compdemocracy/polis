import { faker } from '@faker-js/faker'
import { containerState } from '../../config/test-context.js'
import { createConversation } from './conversation.js'
import { createParticipant } from './participant.js'
import { createUser } from './user.js'

export const createComment = async ({ zid, uid, txt } = {}) => {
  const pool = containerState.getPool()

  if (!uid) {
    const { user } = await createUser()
    uid = user.uid
  }

  if (!zid) {
    const conversation = await createConversation({ owner: uid })
    zid = conversation.zid
  }

  // Ensure participant exists before creating comment
  const participant = await createParticipant({ zid, uid })

  const comment = {
    zid,
    uid,
    pid: participant.pid,
    txt: txt || faker.lorem.sentence(),
  }

  const result = await pool.query(
    'INSERT INTO comments (zid, uid, pid, txt) VALUES ($1, $2, $3, $4) RETURNING *',
    [comment.zid, comment.uid, comment.pid, comment.txt]
  )
  return result.rows[0]
}
