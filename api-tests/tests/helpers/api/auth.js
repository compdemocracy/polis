import { containerState } from '../../config/test-context.js'

export const authenticateUser = async () => {
  const request = containerState.getRequest()

  // Create user via API
  const createResponse = await request
    .post('/api/v3/auth/new')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send({
      hname: 'Test User',
      email: 'test@example.com',
      password: 'testpass123',
      password2: 'testpass123',
      gatekeeperTosPrivacy: true,
      is_owner: true,
    })

  if (!createResponse.ok) {
    console.error(
      'User creation response:',
      createResponse.status,
      createResponse.body
    )
    throw new Error(
      `Failed to create user: ${JSON.stringify(createResponse.body)}`
    )
  }

  // Login with created user
  const loginResponse = await request
    .post('/api/v3/auth/login')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send({
      email: 'test@example.com',
      password: 'testpass123',
    })

  // Check both token and cookies exist
  if (!loginResponse.body.token || !loginResponse.headers['set-cookie']) {
    console.error('Login response:', loginResponse.status, loginResponse.body)
    throw new Error(
      `Authentication failed: ${JSON.stringify(loginResponse.body)}`
    )
  }

  // Return both user info and token
  return {
    user: createResponse.body,
    token: loginResponse.body.token,
    // Store cookies in the agent automatically via supertest
  }
}
