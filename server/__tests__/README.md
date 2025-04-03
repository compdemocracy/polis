# Testing Guide

This directory contains the test suite for the Polis server. The tests are organized by type (unit, integration, e2e) and use Jest as the test runner.

## Getting Started

To run the tests, you'll need:

- A local PostgreSQL database for testing
- Node.js and npm installed

## Running Tests

### All Tests

```bash
npm test
```

### Unit Tests Only

```bash
npm run test:unit
```

### Integration Tests Only

```bash
npm run test:integration
```

### Feature Tests Only

```bash
npm run test:feature
```

### Run Specific Tests

```bash
# Run tests in a specific file
npm test -- __tests__/integration/participation.test.js

# Run tests that match a specific name
npm test -- -t "should do something specific"
```

## Database Setup for Tests

The tests require a clean database state to run successfully. There are several ways to manage this:

### Option 1: Reset Database Before Running Tests

This will completely reset your database, dropping and recreating it with a fresh schema:

```bash
# Reset the database immediately
npm run db:reset

# Run tests with a database reset first
RESET_DB_BEFORE_TESTS=true npm test
```

⚠️ **WARNING**: The `db:reset` script will delete ALL data in the database specified by `DATABASE_URL`.

## Mailer Testing

A maildev container is typically running (see `docker-compose.dev.yml`) and will capture emails sent during testing. You can view the emails at `http://localhost:1080` (SMTP port 1025).

The test suite includes helper functions in `__tests__/setup/email-helpers.js` to interact with MailDev:

```javascript
// Find an email sent to a specific recipient
const email = await findEmailByRecipient('test@example.com');

// Get all emails currently in MailDev
const allEmails = await getEmails();

// Clean up emails before/after tests
await deleteAllEmails();

// Extract password reset URLs from emails
const { url, token } = getPasswordResetUrl(email);
```

## Response Format Handling

The test suite includes robust handling for the various response formats from the API:

- **JSON Responses**: Automatically parsed into JavaScript objects
- **Text Responses**: Preserved as strings
- **Gzipped Content**: Automatically detected and decompressed, even when incorrectly marked
- **Mixed Content-Types**: Handles cases where JSON content is served with non-JSON content types

## Test Safety Features

The test environment includes this safety feature:

- **Production Database Prevention**: Tests will not run against production databases (URLs containing 'amazonaws', 'prod', etc.)

## Troubleshooting Common Issues

### Participant Creation Issues

If tests fail with duplicate participant errors, try:

```bash
npm run db:reset
```

### Database Connection Errors

Check that:

1. Your PostgreSQL server is running
2. Your DATABASE_URL environment variable is correct
3. Database and schema exist (you can use `npm run db:reset` to create them)

### Test Timeouts

If tests timeout, try:

1. Increase the timeout in individual tests:

   ```javascript
   jest.setTimeout(90000); // Set timeout to 90 seconds
   ```

2. Check for any blocking async operations that might not be resolving
