# Checklist for Integration Tests

This checklist tracks API endpoints and functional domains that should be tested in the integration test suite. This ensures comprehensive coverage of the API and helps identify gaps in testing.

## Legend

- ✅ Fully tested
- 🔶 Partially tested
- ❌ Not tested yet
- ⛔️ Expected to fail, or has known issues
- 🙈 Out of scope

## Authentication

### Auth Endpoints

- ✅ POST /auth/new - User registration
- ✅ POST /auth/login - User login
- ✅ POST /auth/deregister - User logout
- ✅ POST /auth/pwresettoken - Password reset token
- ✅ GET /auth/pwreset - Password reset page
- ✅ POST /auth/password - Process password reset

### Auth Features

- ✅ Anonymous participation
- ✅ Authenticated participation
- ✅ Token-based authentication
- ✅ Cookie-based authentication
- ✅ XID-based authentication
- ✅ Password reset flow

## Conversations

### Conversation Management

- ✅ POST /conversations - Create conversation
- ✅ GET /conversations - List conversations
- ✅ GET /conversation/:conversation_id - Get conversation details
- ✅ PUT /conversations - Update conversation
- ⛔️ POST /conversation/close - Close conversation
- ⛔️ POST /conversation/reopen - Reopen conversation
- 🔶 POST /reserve_conversation_id - Reserve conversation ID

### Conversation Features

- ✅ Public vs. private conversations
- ⛔️ Conversation closure
- ✅ Conversation sharing settings
- 🙈 Conversation monitoring
- 🙈 Conversation embedding
- ✅ Conversation statistics
- ✅ Conversation preload information
- 🔶 Recent conversation activity

## Comments

### Comment Endpoints

- ✅ POST /comments - Create comment
- ✅ GET /comments - List comments
- 🙈 GET /comments/translations - Get comment translations
- ✅ PUT /comments - Update comment

### Comment Features

- ✅ Comment creation
- ✅ Comment retrieval with filters
- ✅ Comment moderation
- 🔶 Comment flagging
- 🙈 Comment translation

## Participation

### Participation Endpoints

- ✅ GET /participationInit - Initialize participation
- ✅ GET /participation - Get participation data
- ✅ GET /nextComment - Get next comment for voting
- ✅ POST /participants - Participant metadata
- ✅ PUT /participants_extended - Update participant settings

### Participation Features

- ✅ Anonymous participation
- ✅ Authenticated participation
- ✅ XID-based participation
- ✅ Participation with custom metadata
- 🔶 POST /query_participants_by_metadata - Query participants by metadata

## Voting

### Vote Endpoints

- ✅ POST /votes - Submit vote
- ✅ GET /votes - Get votes
- ✅ GET /votes/me - Get my votes
- 🔶 GET /votes/famous - Get famous votes
- 🔶 POST /stars - Star comments
- 🔶 POST /upvotes - Upvote comments

### Vote Features

- ✅ Anonymous voting
- ✅ Authenticated participation
- ✅ Vote retrieval
- ✅ Vote updating

## Math and Analysis

### Math Endpoints

- ✅ GET /math/pca2 - Principal Component Analysis
- ✅ GET /math/correlationMatrix - Get correlation matrix
- 🙈 POST /math/update - Trigger math recalculation
- 🔶 GET /bid - Get bid mapping
- 🔶 GET /bidToPid - Get bid to pid mapping
- 🔶 GET /xids - Get XID information

### Report Endpoints

- 🔶 GET /reports - Get reports
- 🔶 POST /reports - Create report
- 🔶 PUT /reports - Update report
- 🙈 GET /reportNarrative - Get report narrative
- ⛔️ GET /snapshot - Get conversation snapshot

## Data Export

### Export Endpoints

- 🔶 GET /dataExport - Export conversation data
- 🔶 GET /dataExport/results - Get export results
- 🔶 GET /reportExport/:report_id/:report_type - Export report
- ❌ GET /xid/:xid_report - Get XID report

## System and Utilities

### Health Endpoints

- ✅ GET /testConnection - Test connectivity
- ✅ GET /testDatabase - Test database connection

### Context and Metadata

- ✅ GET /contexts - Get available contexts
- ✅ POST /contexts - Create context
- ✅ GET /domainWhitelist - Get whitelisted domains
- ✅ POST /domainWhitelist - Update whitelisted domains
- 🔶 POST /xidWhitelist - Update XID whitelist

### Metadata Management

- ✅ GET /metadata/questions - Get metadata questions
- ✅ POST /metadata/questions - Create metadata question
- ✅ DELETE /metadata/questions/:pmqid - Delete metadata question
- ✅ GET /metadata/answers - Get metadata answers
- ✅ POST /metadata/answers - Create metadata answer
- ✅ DELETE /metadata/answers/:pmaid - Delete metadata answer
- 🔶 GET /metadata - Get all metadata
- 🔶 GET /metadata/choices - Get metadata choices

### Miscellaneous

- ✅ POST /tutorial - Track tutorial steps
- ✅ POST /einvites - Send email invites
- ✅ GET /einvites - Get email invites
- ✅ GET /verify - Email invite verification
- ❌ GET /tryCookie - Test cookie functionality
- 🙈 GET /perfStats_9182738127 - Performance statistics
- 🙈 GET /dummyButton - Test dummy button
- ✅ GET /conversationPreloadInfo - Get conversation preload info
- ✅ GET /conversationStats - Get conversation statistics
- ❌ GET /conversationUuid - Get conversation UUID
- 🔶 GET /conversationsRecentActivity - Get recent activity
- 🔶 GET /conversationsRecentlyStarted - Get recently started conversations

## Extended Features

### User Management

- ✅ GET /users - List users (admin)
- ✅ PUT /users - Update user (admin)
- ✅ POST /users/invite - Invite users (admin)
- 🔶 POST /joinWithInvite - Join with invite

### Social Features

- 🔶 GET /ptptois - Get participant ois
- 🔶 PUT /ptptois - Update participant ois
- 🙈 GET /locations - Get locations

### Notifications

- ✅ GET /notifications/subscribe - Subscribe to notifications
- ✅ GET /notifications/unsubscribe - Unsubscribe from notifications
- ✅ POST /convSubscriptions - Subscribe to conversation updates
- ✅ POST /sendCreatedLinkToEmail - Send created link to email
- 🔶 POST /sendEmailExportReady - Send email export ready notification
- ❌ POST /notifyTeam - Notify team

## Reports and Exports

- ✅ GET /api/v3/reports - Get reports
- ✅ POST /api/v3/reports - Create report
- ✅ PUT /api/v3/reports - Update report
- ✅ GET /api/v3/reportExport/:report_id/:report_type - Export report data
- ✅ GET /api/v3/dataExport - Initiate data export task
- ❌ GET /api/v3/dataExport/results - Get export results (requires S3 setup)

## Notes on Test Implementation

1. **Legacy Quirks**: Tests should handle the known quirks of the legacy server, including:
   - Plain text responses with content-type: application/json
   - Error responses as text rather than structured JSON
   - Falsy IDs (0 is a valid ID)

2. **Handling Authentication**: Tests should verify all authentication methods:
   - Token-based auth
   - Cookie-based auth
   - Combined auth strategies

3. **Coverage Strategy**: Focus on:
   - Core user flows first
   - Edge cases and validation
   - Error handling
   - Authentication and authorization

4. **Known Issues**: Be aware of potential stability issues with:
   - `/conversation/close` endpoint (may hang)
   - `/auth/deregister` endpoint (may timeout)
   - `/comments/translations` endpoint (always returns 400 error)

## Out-of-Scope Features

Some features of the server are considered out-of-scope for integration testing due to being deprecated, unused, or requiring external integrations that would be difficult to test reliably:

- **Embedded conversations**: The embedding functionality (`/embed`, `/embedPreprod`, `/embedReport`, etc.) is best tested in end-to-end testing rather than integration testing.
- **Locations / geocode**: The location-based features (`/api/v3/locations`) would require third-party geocoding services.
- **Social integrations**: Features related to social media integration are not prioritized for testing.
- **Report narrative**: The `/api/v3/reportNarrative` endpoint requires complex setup and may be better suited for manual testing.
- **Translations**: Comment translation features (`/api/v3/comments/translations`) depend on external translation services.
- **Performance and monitoring**: Endpoints like `/perfStats_9182738127` are designed for production monitoring rather than regular API usage.

Some of these features may be covered by manual testing or end-to-end tests instead of integration tests, or may be deprecated in future versions of the application.

## Current Coverage

Based on the latest coverage report:

- Overall code coverage: ~40% statements, ~38% branches, ~41% functions
- Key areas with good coverage:
  - App.js: 93% statements
  - Password-related functionality: 82% statements  
  - Conversation management: 65% statements
  - Voting: 68% statements in routes
- Areas needing improvement:
  - Notification functionality: 0% coverage
  - Report functionality: 0-4% coverage
  - Export functionality: 1-22% coverage

### Participant & User Metadata

- ✅ GET /api/v3/metadata - Get all metadata for a conversation
- ✅ GET /api/v3/metadata/questions - Get metadata questions for a conversation
- ✅ POST /api/v3/metadata/questions - Create a metadata question
- ✅ DELETE /api/v3/metadata/questions/:pmqid - Delete a metadata question
- ✅ GET /api/v3/metadata/answers - Get metadata answers for a conversation
- ✅ POST /api/v3/metadata/answers - Create a metadata answer
- ✅ DELETE /api/v3/metadata/answers/:pmaid - Delete a metadata answer
- ✅ GET /api/v3/metadata/choices - Get metadata choices for a conversation
- ✅ POST /api/v3/query_participants_by_metadata - Query participants by metadata
- ✅ PUT /api/v3/participants_extended - Update participant extended settings
