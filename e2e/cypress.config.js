const { defineConfig } = require('cypress')

// One way to run Cypress against a different url is to pass CYPRESS_BASE_URL env variable,
// e.g. CYPRESS_BASE_URL=http://localhost:80 npm test,

module.exports = defineConfig({
  blockHosts: ['*.twitter.com', '*.jsdelivr.net'],
  e2e: {
    baseUrl: 'http://localhost:5000',
    video: false,
    setupNodeEvents(/*on, config*/) {
      // implement node event listeners here
    },
  },
})
