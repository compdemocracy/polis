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

beforeAll(async () => {
  network = await new Network().start()

  // Start Postgres container
  console.log('Starting Postgres container...')
  dbContainer = await new GenericContainer('postgres:14')
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
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
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
        DEBUG: 'polis:*',
        DEV_MODE: 'true',
      })
      .withStartupTimeout(TIMEOUT)
      .withWaitStrategy(
        Wait.forAll([
          Wait.forListeningPorts(),
          Wait.forLogMessage('started on port'),
          Wait.forHttp('/api/v3/testConnection', 5000)
            .forStatusCode(200)
            .withStartupTimeout(TIMEOUT),
          Wait.forHttp('/api/v3/testDatabase', 5000)
            .forStatusCode(200)
            .withStartupTimeout(TIMEOUT),
        ])
      )
  }

  // Start API container with configurable source
  console.log('Starting API container...')
  const apiConfig = config.api ?? {} // Add API config to your environment.js
  console.log('API config:', apiConfig)
  let containerBuilder

  if (apiConfig.dockerImage) {
    // Use hosted Docker image
    containerBuilder = new GenericContainer(apiConfig.dockerImage)
  } else {
    // Build from Dockerfile
    const dockerfilePath = apiConfig.dockerfilePath ?? '../server'
    containerBuilder = await GenericContainer.fromDockerfile(
      dockerfilePath
    ).build('polis-api-test-image', { deleteOnExit: false })
  }

  apiContainer = await configureApiContainer(containerBuilder)
    .start()
    .then(async (startedContainer) => {
      // Only log API container output if DEBUG_API_CONTAINER is set
      if (process.env.DEBUG_API_CONTAINER) {
        startedContainer
          .logs()
          .then((stream) => {
            stream.on('data', (line) => {
              console.log('API Container:', line.toString('utf8'))
            })
          })
          .catch(console.error)
      }
      return startedContainer
    })
  console.log('API container started')

  // Store container info
  containerState.setApiContainer(
    apiContainer,
    apiContainer.getHost(),
    apiContainer.getMappedPort(5000)
  )

  containerState.setPostgresContainer(dbContainer, config)
}, TIMEOUT)

afterAll(async () => {
  await containerState.stopContainers()
  await network?.stop()
}, TIMEOUT)

// Reset database between tests
beforeEach(async () => {
  console.log('Resetting database...')
  await containerState.resetDatabase()
}, TIMEOUT)
