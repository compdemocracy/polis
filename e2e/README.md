# polis-cypress

End-To-End Tests written with cypress.io

To run these tests:

1. Enter the subdir of the cloned repository
`cd e2e`

2. Install npm dependencies
`npm install`

3. Open up the Cypress App
`npm run cypress`

4. Click on tests to run
    - Alternatively, you can run all tests automatically: `npm test`

## Notes

- We keep some helper scripts in `package.json`.
- The default base url for running tests against, is https://preprod.pol.is
  - You may override this like so: `CYPRESS_BASE_URL=http://123.45.67.89.xip.io npm test`
- `cypress/integration/polis/`: where we store our tests
- `cypress/integration/examples`: where we store boilerplate examples
- `cypress/support/commands.js`: where we keep oft-used commands, e.g., for logging in, creating conversations, etc.
- `cypress/support/index.js`: where we keep code we wish to run during initial setup, e.g., to ensure default users present.
- For tests against features that require third-party credentials when self-hosted, we use filenames like `*.secrets.spec.js`.
  - This allows someone to easily exclude them from test runs.
- These tests are run automatically on pull requests and mainline branch.
  - We use a GitHub Actions workflow, configured via [`.github/workflows/cypress-tests.yml`](/.github/workflows/cypress-tests.yml).
