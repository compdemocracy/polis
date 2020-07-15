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

- The default base url is https://preprod.pol.is
  - You may override this like so: `CYPRESS_BASE_URL=http://123.45.67.89.xip.io npm test`
- We store our tests in `cypress/integration/polis/`
- We store templated examples in `cypress/integration/examples/`
- For tests against features that require third-party credentials when self-hosted, we use filenames like `*.secrets.spec.js`.
  - This allows someone to easily exclude them from test runs. (See `package.json` for helper commands.)
- These tests are run automatically on pull requests and mainline branch.
  - We use a GitHub Actions workflow, configured via [`.github/workflows/cypress-tests.yml`](/.github/workflows/cypress-tests.yml).
