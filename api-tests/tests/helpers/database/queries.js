import { containerState } from '../../config/test-context.js'

export const dbHas = {
  user: async (criteria) => {
    const pool = containerState.getPool()
    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)',
      [criteria.username]
    )
    return result.rows[0].exists
  },

  conversation: async (criteria) => {
    const pool = containerState.getPool()
    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM conversations WHERE zid = $1)',
      [criteria.zid]
    )
    return result.rows[0].exists
  },

  comment: async (criteria) => {
    const pool = containerState.getPool()
    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM comments WHERE zid = $1 AND tid = $2)',
      [criteria.zid, criteria.tid]
    )
    return result.rows[0].exists
  },
}

export const dbFind = {
  vote: async ({ tid, conversation_id, token }) => {
    const pool = containerState.getPool()
    const result = await pool.query(
      `SELECT votes.* 
       FROM votes 
       JOIN participants p ON votes.pid = p.pid 
       JOIN zinvites z ON votes.zid = z.zid
       WHERE votes.tid = $1 
       AND z.zinvite = $2
       AND p.uid = (SELECT uid FROM auth_tokens WHERE token = $3)`,
      [tid, conversation_id, token]
    )
    return result.rows[0]
  },

  comment: async ({ tid, conversation_id }) => {
    const pool = containerState.getPool()
    const result = await pool.query(
      `SELECT comments.* 
       FROM comments 
       JOIN zinvites z ON comments.zid = z.zid
       WHERE comments.tid = $1 
       AND z.zinvite = $2`,
      [tid, conversation_id]
    )
    return result.rows[0]
  },

  commentByTid: async (tid) => {
    const pool = containerState.getPool()
    const result = await pool.query('SELECT * FROM comments WHERE tid = $1', [
      tid,
    ])
    return result.rows[0]
  },
}

export const dbValidate = {
  commentLength: (text) => text.length <= 997,
}
