# Polis E2E Tests

## Setup

```bash
npm install
```

## Documentation

- **[BEST-PRACTICES.md](./BEST-PRACTICES.md)** - General Cypress patterns, gotchas, and best practices
- **[E2E-AUTHENTICATION-GUIDE.md](./E2E-AUTHENTICATION-GUIDE.md)** - Authentication patterns for OIDC and participant testing
- **[JWT_TEST_SETUP.md](./JWT_TEST_SETUP.md)** - JWT test setup for anonymous participants
- **[PARTICIPANT-TESTING.md](./PARTICIPANT-TESTING.md)** - Participant authentication testing guide
- **[EMBED-TESTING.md](./EMBED-TESTING.md)** - Embed and integrated conversation testing guide
- **[VISUALIZATION-TESTING.md](./VISUALIZATION-TESTING.md)** - Requirements for visualization tests

## Run All Tests

```bash
npm test
```

## Run Specific Test Categories

```bash
# Run admin interface tests
npm run test:admin

# Run authentication tests
npm run test:auth

# Run participation & embed tests
npm run test:participation

# Run embed functionality tests
npm run test:embed

# Run site integration tests
npm run test:integrated

# Run specific conversation workflow tests
npm run test:conversation
```

## Run Individual Tests

### Method 1: Using --spec flag

```bash
# Run specific file
npx cypress run --spec cypress/e2e/client-admin/conversation.cy.js

# Or with npm script
npm run cy:run -- --spec cypress/e2e/client-admin/conversation.cy.js
```

### Method 2: Using .only() in test files

Add `.only()` to focus on specific tests:

```javascript
// Focus on single describe block
describe.only('Create New Conversation', () => {
  // Only this block runs
})

// Focus on single test
it.only('should create a new conversation', () => {
  // Only this test runs
})
```

**Remember to remove `.only()` after testing!**

## Open Cypress GUI

```bash
npm run cy:open
```

In the GUI, you can click individual test files or specific tests to run them in isolation.

## Embed Testing

This e2e suite includes comprehensive testing for Polis embed functionality with JWT authentication:

- **Embed Tests** (`embeds.cy.js`): Test single conversation embeds with various configuration options
- **Integration Tests** (`integrated.cy.js`): Test site-wide conversation integration with automatic creation

The embed testing infrastructure includes:

- HTML templates for generating test pages
- Build scripts for creating embed configurations
- Cookie-free JWT authentication
- Environment-aware base URLs (respects `BASE_URL`/`CYPRESS_BASE_URL` variables)
- Support for all embed display options (ucv, ucw, ucsh, etc.)

For detailed documentation, see [EMBED-TESTING.md](./EMBED-TESTING.md).
