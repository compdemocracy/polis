# polis-cypress
End-To-End Tests written with cypress.io

To run these tests:

1. Install npm dependencies:
    * `cd e2e`
    * `npm install`

2. For "headless" testing:
    * `$(npm bin)/cypress run`, or
    * `$(npm bin)/cypress run --spec cypress/integration/polis/client-participation/i18n.spec.js` 

3. For gui testing, open up the Cypress App:
    * `npm test`
    * Click on tests to run
