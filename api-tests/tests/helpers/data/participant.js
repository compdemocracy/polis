import { containerState } from '../../config/test-context.js'
import { createUser } from './user.js'
import { createConversation } from './conversation.js'

export const createParticipant = async ({ zid, uid } = {}) => {
  const pool = containerState.getPool()

  if (!uid) {
    const { user } = await createUser()
    uid = user.uid
  }

  if (!zid) {
    const conversation = await createConversation({ owner: uid })
    zid = conversation.zid
  }

  const result = await pool.query(
    'INSERT INTO participants (zid, uid) VALUES ($1, $2) RETURNING *',
    [zid, uid]
  )
  return result.rows[0]
}
