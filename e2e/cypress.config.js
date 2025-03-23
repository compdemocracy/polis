const { defineConfig } = require('cypress')

// One way to run Cypress against a different url is to pass CYPRESS_BASE_URL env variable,
// e.g. CYPRESS_BASE_URL=http://localhost:5000 npm test
// See https://docs.cypress.io/guides/guides/environment-variables

module.exports = defineConfig({
  blockHosts: ['*.jsdelivr.net'],
  // required to test within iframe:
  chromeSecurity: false,
  requestTimeout: 10000,
  e2e: {
    baseUrl: 'http://localhost',
    experimentalRunAllSpecs: true,
    video: false,
    setupNodeEvents(on /*, config*/) {
      // implement node event listeners here
      require('cypress-terminal-report/src/installLogsPrinter')(on)
    },
  },
  env: {
    maildevUrl: 'http://localhost:1080',
  },
})
