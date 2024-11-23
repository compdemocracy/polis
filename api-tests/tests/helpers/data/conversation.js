import { faker } from '@faker-js/faker'
import { containerState } from '../../config/test-context.js'
import { createUser } from './user.js'

export const createConversation = async (overrides = {}) => {
  const pool = containerState.getPool()

  if (!overrides.owner) {
    const { user } = await createUser()
    overrides.owner = user.uid
  }

  const defaults = {
    topic: faker.lorem.sentence(),
    description: faker.lorem.paragraph(),
    is_active: true,
    is_draft: false,
    is_public: true,
    owner: overrides.owner,
  }
  const data = { ...defaults, ...overrides }

  const result = await pool.query(
    `
      INSERT INTO conversations (
        topic,
        description,
        is_active,
        is_draft, 
        is_public,
        owner
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [
      data.topic,
      data.description,
      data.is_active,
      data.is_draft,
      data.is_public,
      data.owner,
    ]
  )

  // Create default zinvite for the conversation
  await pool.query(
    `
      INSERT INTO zinvites (zid, zinvite)
      VALUES ($1, $2)
    `,
    [result.rows[0].zid, faker.string.alphanumeric(12)]
  )

  return result.rows[0]
}
