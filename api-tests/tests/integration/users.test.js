import { containerState } from '../config/test-context.js'
import { createUser } from '../helpers/data/user.js'

describe('Users API', () => {
  describe('POST /api/v3/auth/new', () => {
    it('should create a new user or login existing', async () => {
      const { user, credentials } = await createUser({
        hname: 'Test User',
        email: 'test@example.com',
      })

      expect(user).toHaveProperty('uid')

      const pool = containerState.getPool()
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [
        credentials.email,
      ])

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({
        email: credentials.email,
        hname: credentials.hname,
      })
    })
  })
})
