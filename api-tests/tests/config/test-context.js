import pg from 'pg'
import supertest from 'supertest'
const { Pool } = pg

class TestContext {
  static #instance = null
  #request = null
  #pool = null

  constructor() {
    if (TestContext.#instance) {
      throw new Error('Use TestContext.getInstance() instead of new operator')
    }

    this.containers = {
      api: null,
      postgres: null,
    }

    TestContext.#instance = this
  }

  static getInstance() {
    if (!TestContext.#instance) {
      TestContext.#instance = new TestContext()
    }
    return TestContext.#instance
  }

  setApiContainer(container, host, port) {
    this.containers.api = {
      url: `http://${host}:${port}`,
      container,
    }
    // Reset request client when API container changes
    this.#request = null
  }

  setPostgresContainer(container, config) {
    this.containers.postgres = {
      url: `postgres://${config.database.user}:${config.database.password}@${container.getHost()}:${container.getMappedPort(5432)}/${config.database.testName}`,
      container,
    }
    // Reset pool when Postgres container changes
    this.#pool = null
  }

  getApiUrl() {
    if (!this.containers.api) {
      throw new Error('API container not initialized')
    }
    return this.containers.api.url
  }

  getRequest() {
    if (!this.#request) {
      const API_URL = this.getApiUrl()
      const agent = supertest.agent(API_URL)

      // Create a wrapped version that maintains context and cookies
      this.#request = {
        get: (url) => this.#wrapRequest(agent.get(url)),
        post: (url) => this.#wrapRequest(agent.post(url)),
        put: (url) => this.#wrapRequest(agent.put(url)),
        delete: (url) => this.#wrapRequest(agent.delete(url)),
      }
    }
    return this.#request
  }

  #wrapRequest(request) {
    // Track headers and cookies in closure
    const headers = {}
    let cookieHeader = null
    const debug = process.env.DEBUG_API_REQUESTS === 'true'

    // Wrap the set method to capture headers
    const originalSet = request.set
    request.set = function (field, val) {
      headers[field] = val
      // If this is a token, also set it as a cookie
      if (field === 'x-polis-token') {
        cookieHeader = `token2=${val}`
        originalSet.call(this, 'Cookie', cookieHeader)
      }
      if (debug) {
        console.log('Setting header:', field, val)
      }
      return originalSet.call(this, field, val)
    }

    // Log before sending
    const originalSend = request.send
    request.send = function (data) {
      if (debug) {
        console.log('Sending request:', {
          method: this.method,
          url: this.url,
          headers,
          cookies: cookieHeader,
          data,
        })
      }
      return originalSend.call(this, data)
    }

    // Log after response
    const originalEnd = request.end
    request.end = function (fn) {
      return originalEnd.call(this, (err, res) => {
        if (debug) {
          console.log('Response received:', {
            status: res?.status,
            headers: res?.headers,
            body: res?.body,
          })
        }
        fn(err, res)
      })
    }

    return request
  }

  getPool() {
    if (!this.#pool) {
      if (!this.containers.postgres) {
        throw new Error(
          'Database configuration not found. Did the container setup fail?'
        )
      }

      const url = new URL(this.containers.postgres.url)
      const config = {
        host: url.hostname,
        port: url.port,
        database: url.pathname.slice(1),
        user: url.username,
        password: url.password,
      }

      this.#pool = new Pool(config)
    }
    return this.#pool
  }

  async resetDatabase() {
    const pool = this.getPool()
    const tables = ['comments', 'participants', 'conversations', 'users']

    for (const table of tables) {
      await pool.query(`TRUNCATE TABLE ${table} CASCADE`)
    }
  }

  async stopContainers() {
    // First close all DB connections
    if (this.#pool) {
      await this.#pool.end()
      this.#pool = null
    }

    // Then stop containers
    await Promise.all([
      this.containers.api?.container.stop(),
      this.containers.postgres?.container.stop(),
    ])

    this.#request = null
    this.containers.api = null
    this.containers.postgres = null
  }
}

export const containerState = TestContext.getInstance()

Object.freeze(containerState)
