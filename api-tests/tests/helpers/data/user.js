import { faker } from '@faker-js/faker'
import { containerState } from '../../config/test-context.js'

// TODO: Convert this to a DB Query
export const createUser = async (overrides = {}) => {
  const request = containerState.getRequest()
  const defaults = {
    hname: faker.person.fullName(),
    email: faker.internet.email(),
    password: faker.internet.password(),
    gatekeeperTosPrivacy: 'true',
  }

  const payload = { ...defaults, ...overrides }

  const response = await request
    .post('/api/v3/auth/new')
    .send(payload)
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')

  if (response.status === 403) {
    const loginResponse = await request
      .post('/api/v3/auth/login')
      .send({
        email: payload.email,
        password: payload.password,
      })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')

    return { user: loginResponse.body, credentials: payload }
  }

  return { user: response.body, credentials: payload }
}
