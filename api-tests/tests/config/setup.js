import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { GenericContainer, Network, Wait } from 'testcontainers'
import { config } from './environment.js'
import { containerState } from './test-context.js'

const { Client } = pg
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TIMEOUT = 180_000

let dbContainer
let apiContainer
let network

async function validateDockerSetup() {
  const dockerfilePath = config.api.dockerfilePath ?? '../server'
  const fullPath = path.resolve(__dirname, '../../', dockerfilePath)

  try {
    await fs.access(path.join(fullPath, 'Dockerfile'))
  } catch (error) {
    throw new Error(`Dockerfile not found at ${fullPath}. Please ensure API_DOCKERFILE_PATH is correct or API_DOCKER_IMAGE is set.`)
  }
}

beforeAll(async () => {
  try {
    // Validate Docker setup first
    if (!config.api.dockerImage) {
      await validateDockerSetup()
    }

    network = await new Network().start()

    // Start Postgres container
    dbContainer = await new GenericContainer('postgres:16-alpine')
      .withNetwork(network)
      .withNetworkAliases('postgres-test-db')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: config.database.user,
        POSTGRES_PASSWORD: config.database.password,
        POSTGRES_DB: config.database.name,
        POSTGRES_INITDB_ARGS: '--auth-local=trust --auth-host=md5',
      })
      .withCommand([
        'postgres',
        '-c', 'fsync=off',
        '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off',
      ])
      .withStartupTimeout(TIMEOUT)
      .withWaitStrategy(
        Wait.forAll([
          Wait.forListeningPorts(),
          Wait.forLogMessage('database system is ready to accept connections'),
        ])
      )
      .start()

    const schema = await fs.readFile(
      path.resolve(__dirname, '../../schema.sql'),
      'utf8'
    )

    const client = new Client({
      host: dbContainer.getHost(),
      port: dbContainer.getMappedPort(5432),
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
    })

    try {
      await client.connect()
      await client.query('DROP DATABASE IF EXISTS "polis_test"')
      await client.query('CREATE DATABASE polis_test')
      await client.end()

      const testClient = new Client({
        host: dbContainer.getHost(),
        port: dbContainer.getMappedPort(5432),
        database: 'polis_test',
        user: 'postgres',
        password: 'test-password',
      })

      try {
        await testClient.connect()
        await testClient.query(schema)
        await testClient.query('DROP DATABASE IF EXISTS "polis_test_template"')
        await testClient.query(
          'CREATE DATABASE polis_test_template WITH TEMPLATE polis_test'
        )
      } finally {
        await testClient.end()
      }
    } finally {
      if (!client.ended) await client.end()
    }

    // Helper function to configure API container
    const configureApiContainer = (container) => {
      return container
        .withNetwork(network)
        .withExposedPorts(5000)
        .withEnvironment({
          API_DEV_HOSTNAME: `localhost:${config.api.port || 5000}`,
          API_SERVER_PORT: config.api.port || 5000,
          DATABASE_URL: `postgres://${config.database.user}:${config.database.password}@postgres-test-db:5432/${config.database.testName}`,
          NODE_ENV: 'development',
          DEBUG: process.env.DEBUG_API_CONTAINER === 'true' ? 'polis:*' : '',
          DEV_MODE: 'true',
          SERVER_LOG_LEVEL: 'info',
        })
        .withStartupTimeout(TIMEOUT)
        .withWaitStrategy(
          Wait.forAll([
            Wait.forListeningPorts(),
            Wait.forLogMessage('started on port'),
            // Only use HTTP health checks if not in debug mode to avoid excessive logging
            ...(process.env.DEBUG_API_CONTAINER === 'true' ? [] : [
              Wait.forHttp('/api/v3/testConnection', 5000)
                .forStatusCode(200)
                .withStartupTimeout(TIMEOUT),
            ]),
          ])
        )
    }

    // Start API container with configurable source
    const apiConfig = config.api ?? {}
    let containerBuilder

    if (apiConfig.dockerImage) {
      containerBuilder = new GenericContainer(apiConfig.dockerImage)
    } else {
      const dockerfilePath = apiConfig.dockerfilePath ?? '../server'
      containerBuilder = await GenericContainer.fromDockerfile(
        dockerfilePath
      ).build('polis-api-test-image', { deleteOnExit: true })
    }

    apiContainer = await configureApiContainer(containerBuilder)
      .start()
      .then(async (startedContainer) => {
        // Always log initial container output for debugging
        if (process.env.DEBUG_API_CONTAINER === 'true') {
          const logs = await startedContainer.logs()
          logs.on('data', (line) => {
            console.log('API Container startup:', line.toString('utf8'))
          })

          // Set up ongoing logging if debug is enabled
          startedContainer
            .logs()
            .then((stream) => {
              stream.on('data', (line) => {
                console.log('API Container:', line.toString('utf8'))
              })
            })
            .catch(console.error)
        }

        // Store container info
        containerState.setApiContainer(
          startedContainer,
          startedContainer.getHost(),
          startedContainer.getMappedPort(5000)
        )

        containerState.setPostgresContainer(dbContainer, config)

        return startedContainer
      })
  } catch (error) {
    console.error('Error during test setup:', error)
    // Attempt cleanup on setup failure
    await containerState.stopContainers().catch(e => console.error('Error stopping containers:', e))
    await network?.stop().catch(e => console.error('Error stopping network:', e))
    throw error
  }
}, TIMEOUT)

afterAll(async () => {
  try {
    await containerState.stopContainers()
    if (network) {
      await network.stop()
    }

    // Clean up mock API temp directory if it exists
    const tempDir = path.resolve(__dirname, '../../temp-mock-api');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
  } catch (error) {
    console.error('Error during cleanup:', error)
    // Don't throw here, just log the error
  }
}, TIMEOUT)

// Reset database between tests
beforeEach(async () => {
  await containerState.resetDatabase()
}, TIMEOUT)
