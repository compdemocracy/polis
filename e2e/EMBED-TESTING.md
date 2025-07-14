# Embed Testing Infrastructure

## Overview

This directory contains infrastructure for testing Polis embed functionality in the new JWT-based authentication system. The embed tests verify that Polis conversations can be properly embedded in external websites and that the various configuration options work correctly.

**Note**: For general Cypress patterns and best practices, see [BEST-PRACTICES.md](./BEST-PRACTICES.md).

## Architecture

The embed testing system consists of:

1. **HTML Templates** - Template files for generating test embed pages
2. **Build Scripts** - Node.js scripts that generate HTML files from templates
3. **Cypress Tests** - E2E tests that verify embed functionality
4. **JWT Authentication** - All authentication now uses JWT tokens instead of cookies

## Files Structure

```txt
e2e/
├── embed/
│   ├── template.html              # Template for single conversation embeds
│   ├── integrated-template.html   # Template for site-wide integrations
│   ├── index.html                 # Generated embed test file (gitignored)
│   └── integrated-index.html      # Generated integrated test file (gitignored)
├── build-embed.js                 # Script to generate embed test files
├── build-integrated.js            # Script to generate integrated test files
└── cypress/e2e/client-participation/
    ├── embeds.cy.js               # Tests for single conversation embeds
    └── integrated.cy.js           # Tests for site-wide integrations
```

## Setup Requirements

**Important**: The embed template files are required for the build scripts to work:

- `e2e/embed/template.html`
- `e2e/embed/integrated-template.html`

If these files are missing, you'll get `ENOENT: no such file or directory` errors when running the tests.

## Key Differences from Legacy

### ✅ JWT Authentication

- **Old**: Cookie-based authentication with potential security issues
- **New**: JWT tokens for all authentication (OIDC for users, custom JWTs for participants)
- **Impact**: More secure, stateless, works better across domains

### ✅ Environment-Aware Base URLs

- **Old**: Hardcoded `http://localhost` (port 80/5000)
- **New**: Uses `BASE_URL` or `CYPRESS_BASE_URL` environment variables with fallback to `http://localhost`
- **Benefit**: Works across different development environments and CI servers

### ✅ Improved Test Helpers

- Uses new auth helpers (`loginStandardUser`, `createTestConversation`)
- Better error handling and logging
- More robust conversation setup

### ✅ No Cookie Dependencies

- Completely removed all cookie-related code
- Embed scripts no longer check for cookie support
- Authentication happens within iframes via JWT

## Improvements from Legacy

Based on analysis of the legacy test patterns, we've implemented several improvements:

- **Custom Cypress Commands**: Added `cy.getIframeBody()`, `cy.interceptEmbed()`, and `cy.interceptIntegrated()` for cleaner test code
- **Better Iframe Handling**: More robust iframe access patterns (see [BEST-PRACTICES.md](./BEST-PRACTICES.md#custom-cypress-commands))
- **Cleaner Test Organization**: Tests automatically handle build commands during execution
- **NPM Scripts**: Dedicated scripts for targeted test runs

## Usage

### Running Embed Tests

**Important**: The tests automatically build the required HTML files during execution, so you don't need to run build commands manually. However, if you want to debug or inspect the generated files, you can build them separately.

```bash
# Run all participation tests (includes embeds)
npm run test:participation

# Run only embed tests
npm run test:embed

# Run only integrated conversation tests
npm run test:integrated

# Run individual test file
npx cypress run --spec 'cypress/e2e/client-participation/embeds.cy.js'
```

### Building Embed Test Files (Optional)

The build scripts generate HTML files from templates for testing. **These are automatically called by the Cypress tests**, but you can run them manually for debugging:

```bash
# Build embed test file (uses BASE_URL/CYPRESS_BASE_URL environment variable)
npm run build:embed -- --id=CONVERSATION_ID

# Build integrated test file (uses BASE_URL/CYPRESS_BASE_URL environment variable)
npm run build:integrated -- --siteId=SITE_ID --pageId=PAGE_ID

# Override base URL if needed
npm run build:embed -- --id=CONVERSATION_ID --url=http://custom-host:8080
```

**Note**: The generated `embed/index.html` and `embed/integrated-index.html` files are temporary and are automatically recreated by each test run.

### Build Script Options

**build-embed.js options:**

- `--conversationId, --id` (required) - Conversation ID to embed
- `--baseUrl, --url` - Base URL for embed script (default: `BASE_URL` or `CYPRESS_BASE_URL` env var, fallback: `http://localhost`)
- `--uiLang, --lang` - UI language (default: en)
- `--ucsd` - user-can-see-description (default: true)
- `--ucsf` - user-can-see-footer (default: true)
- `--ucsh` - user-can-see-help (default: true)
- `--ucst` - user-can-see-topic (default: true)
- `--ucsv` - user-can-see-vis (default: true)
- `--ucv` - user-can-vote (default: true)
- `--ucw` - user-can-write (default: true)

**build-integrated.js options:**

- `--siteId` (required) - Site ID from server
- `--pageId` - Page ID for the conversation (default: PAGE_ID)
- `--baseUrl, --url` - Base URL for embed script (default: `BASE_URL` or `CYPRESS_BASE_URL` env var, fallback: `http://localhost`)

## Test Flow

### Embed Tests (embeds.cy.js)

1. **Setup**: Create conversation with admin user using JWT auth
2. **For Each Test**:
   - Generate embed HTML file with specific configuration (via `npm run build:embed`)
   - Use `cy.interceptEmbed()` to serve the generated file
   - Load embed page and verify iframe content using `cy.getIframeBody()`
3. **Verify**: Check that configuration options properly hide/show features

### Integrated Tests (integrated.cy.js)

1. **Setup**: Get site ID from admin integration page
2. **For Each Test**:
   - Generate integrated HTML file with unique page ID (via `npm run build:integrated`)
   - Use `cy.interceptIntegrated()` to serve the generated file
   - Test conversation auto-creation/reuse behavior
3. **Verify**: Check conversation appears in admin interface and behaves correctly

## Authentication Flow

### For Embed Tests

1. Admin creates conversation using OIDC JWT
2. Anonymous participants access embedded conversation
3. JWTs issued automatically on first action (voting/commenting)
4. No cookies involved in any step

### For Integrated Tests

1. Admin gets site ID using OIDC JWT
2. Page visits create conversations automatically
3. Participants get JWTs from participationInit endpoint
4. All authentication stateless and secure

## Troubleshooting

### Common Issues

**Build script fails:**

- Ensure yargs dependency is installed: `npm install`
- Check that templates exist in `embed/` directory

**Cypress tests fail:**

- Verify OIDC simulator is running: `docker compose up oidc-simulator`
- Check that server is running on the expected port (check `BASE_URL` env var)
- Ensure embed.js is being served by file-server

**iframe content not loading:**

- Check browser console for CORS errors
- Verify participationInit endpoint returns JWT tokens
- Check that embed.js script loads successfully

**Authentication errors:**

- Verify .env file has correct AUTH\_\* variables
- Check that OIDC simulator has test users configured
- Ensure JWT tokens are being stored in localStorage

### Debugging Tips

1. **Check Network Tab**: Look for failed requests to participationInit
2. **Check Console**: Look for JavaScript errors in iframe context
3. **Check Auth**: Verify JWT tokens in localStorage
4. **Check Logs**: Use `cy.log()` output to trace test execution
5. **Use Helper Commands**: Leverage `cy.getIframeBody()` for reliable iframe access

### Common Integration Page Issues

**Site ID shows "loading, try refreshing":**

- **Issue**: React component hasn't finished loading user data yet
- **Solution**: Wait for the actual site_id to load using `.should('not.contain', 'loading, try refreshing')` (see [Waiting Strategies](./BEST-PRACTICES.md#waiting-strategies))

**Integration page not accessible:**

- Verify admin user authentication
- Check that `/integrate` route is properly configured
- Ensure admin user has site_ids generated

## Migration from Legacy

The new embed tests are **100% cookie-free** and use modern JWT authentication:

- ✅ Removed all cookie checking code
- ✅ Updated to use new auth helpers
- ✅ Environment-aware base URLs using `BASE_URL`/`CYPRESS_BASE_URL` variables
- ✅ Improved error handling and reliability
- ✅ Better test organization and documentation
- ✅ Added custom Cypress commands for cleaner tests
- ✅ More robust iframe handling

## Next Steps

- Add tests for XID participant authentication
- Add tests for OIDC user participation in embeds
- Add performance testing for embed load times
- Add accessibility testing for embedded conversations

## ✅ Analysis Complete - Success Summary

**All embed and integrated conversation tests are now working successfully!**

### Analysis Results (16/16 tests passing)

After analyzing the legacy tests and applying lessons learned, we successfully:

1. **✅ Fixed URL Parsing Issue**: Identified and resolved the 400 Bad Request error caused by missing `parent_url` parameter in implicit conversation route
2. **✅ Improved Test Reliability**: Enhanced error handling and response structure validation
3. **✅ Added Redirect Handling**: Properly handled server redirects for existing site_id/page_id combinations
4. **✅ Environment Integration**: Leveraged nginx proxy improvements for seamless localhost testing

### Key Learnings from Legacy Analysis

- **Custom Cypress Commands**: Implemented `cy.getIframeBody()`, `cy.interceptEmbed()`, `cy.interceptIntegrated()` for cleaner test code
- **Better Error Handling**: Made tests more robust to different API response structures
- **URL Parameter Requirements**: Understanding server middleware requirements for embed functionality
- **Redirect Behavior**: Proper handling of conversation reuse redirects

### Final Test Coverage

**Embed Tests (10/10 passing):**

- Participation view parameter visibility (`ucv`, `ucw`, `ucsh`, `ucsd`, `ucsf`, `ucst`, `ucsv`)
- HTML generation with custom configurations
- Environment-aware base URLs

**Integrated Tests (6/6 passing):**

- Automatic conversation creation for site_id/page_id combinations
- Conversation reuse for existing page IDs
- Different conversations for different page IDs
- Default conversation properties validation
- HTML generation and admin integration display

### Infrastructure Benefits

- **100% JWT Authentication**: Completely cookie-free embed system
- **Environment Flexibility**: Works with nginx proxy and direct port access
- **Robust Testing**: Handles both single conversation objects and array responses
- **Clean Documentation**: Comprehensive setup and troubleshooting guides

The embed testing infrastructure is now **production-ready** and provides comprehensive coverage of both standalone embeds and integrated site-wide conversation systems.
