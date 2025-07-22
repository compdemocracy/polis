const { defineConfig } = require('cypress')

// Load environment variables from .env file if it exists
try {
  require('dotenv').config()
} catch {
  // dotenv not available or .env file doesn't exist
}

// One way to run Cypress against a different url is to pass CYPRESS_BASE_URL env variable,
// e.g. CYPRESS_BASE_URL=http://localhost:5000 npm test
// See https://docs.cypress.io/guides/guides/environment-variables

module.exports = defineConfig({
  // required to test within iframe:
  chromeWebSecurity: false,
  requestTimeout: 5000,
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || process.env.BASE_URL || 'http://localhost',
    experimentalRunAllSpecs: true,
    video: false,
    setupNodeEvents(on, config) {
      // implement node event listeners here
      require('cypress-terminal-report/src/installLogsPrinter')(on)

      // Add task to log messages from tests
      on('task', {
        log(message) {
          console.log(message)
          return null
        },
      })

      return config
    },
    env: {
      maildevUrl: process.env.MAILDEV_URL || 'http://localhost:1080',
      // OIDC configuration from environment variables
      AUTH_AUDIENCE: process.env.AUTH_AUDIENCE || 'users',
      AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID || 'dev-client-id',
      AUTH_ISSUER: process.env.AUTH_ISSUER || 'https://localhost:3000/',
      AUTH_NAMESPACE: process.env.AUTH_NAMESPACE || 'https://pol.is/',
      OIDC_CACHE_KEY_PREFIX: process.env.OIDC_CACHE_KEY_PREFIX || 'oidc.user',
    },
  },
})
