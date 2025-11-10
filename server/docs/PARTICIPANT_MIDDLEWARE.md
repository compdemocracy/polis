# Participant Management Middleware

## Overview

The participant management middleware (`ensureParticipant`) provides a clean abstraction for handling the complex participant creation and authentication flow that's common across multiple Polis endpoints. It consolidates logic that was previously duplicated in routes like `/api/v3/votes` and `/api/v3/comments`.

## What It Does

The middleware handles:

1. **JWT Conversation Mismatches** - When a participant has a JWT for a different conversation
2. **Legacy Cookie Support** - Migrating users from the old cookie-based system
3. **Anonymous User Creation** - Creating anonymous users on their first interaction
4. **XID User Management** - Handling external ID users and their allowed listing
5. **Participant Creation** - Creating participant records with proper race condition handling
6. **JWT Issuance** - Issuing appropriate JWTs (Anonymous, XID, or Standard User) for new participants

## Usage

### Basic Usage

```typescript
import { ensureParticipant } from "../auth";

// In app.ts route definition
app.post(
  "/api/v3/votes",
  hybridAuthOptional(assignToP),
  need("conversation_id", getConversationIdFetchZid, assignToPCustom("zid")),
  need("tid", getInt, assignToP),
  need("vote", getIntInRange(-1, 1), assignToP),
  want("xid", getStringLimitLength(1, 999), assignToP),
  ensureParticipant(),  // <-- Add this middleware
  handle_POST_votes
);
```

### With Options

```typescript
// Create participant only if they don't exist, issue JWT
ensureParticipant({
  createIfMissing: true,  // Default: true
  issueJWT: true,         // Default: true
})

// Just check for existing participant, don't create
ensureParticipantOptional({
  createIfMissing: false
})

// Create participant only on action methods (POST, PUT, DELETE)
ensureParticipantOnAction()
```

## What Gets Added to the Request

The middleware works with the centralized `RequestWithP` type defined in `src/d.ts`. After the middleware runs, the request will have:

```typescript
req.p.uid          // User ID (guaranteed to be set)
req.p.pid          // Participant ID (guaranteed to be set)
req.p.participantInfo = {
  uid: number,
  pid: number,
  isNewlyCreatedUser: boolean,
  isNewlyCreatedParticipant: boolean,
  needsNewJWT: boolean,
  token?: string,           // JWT if one was issued
  conversationId?: string
}
req.p.authToken = {         // If JWT was issued
  token: string,
  token_type: "Bearer",
  expires_in: number
}
```

## Type Safety

All route handlers can use the centralized `RequestWithP` type for consistent typing:

```typescript
import { RequestWithP } from "../d";

async function handle_POST_votes(req: RequestWithP, res: any) {
  // req.p is fully typed with all possible fields
  const { uid, pid, zid } = req.p;  // TypeScript knows these exist
  // ...
}
```

## Migration Guide

### Before (Complex Handler)

```typescript
async function handle_POST_votes(req: VoteRequest, res: any) {
  // 100+ lines of participant management logic:
  // - Handle JWT conversation mismatches
  // - Check legacy cookies
  // - Create anonymous users
  // - Get or create participants
  // - Issue JWTs
  // - Handle race conditions
  
  // Finally do the actual work:
  const voteResult = await votesPost(...);
  // ...
}
```

### After (Simple Handler)

```typescript
async function handle_POST_votes(req: VoteRequest, res: any) {
  // Participant management is handled by middleware
  // Just do the actual work:
  const { uid, pid, zid } = req.p;  // Guaranteed to exist
  
  const voteResult = await votesPost(uid, pid, zid, ...);
  
  // Include JWT if one was issued
  if (req.p.authToken) {
    result.auth = req.p.authToken;
  }
  
  res.json(result);
}
```

## Middleware Variants

### `ensureParticipant(options)`

- Always creates participant if missing
- Fails if participant can't be created
- Use for actions that require a participant

### `ensureParticipantOptional(options)`

- Looks up existing participant
- Continues even if not found
- Sets `req.p.participantInfo` to `null` if not found
- Use for read-only operations

### `ensureParticipantOnAction(options)`

- Creates participant only for POST/PUT/DELETE/PATCH
- Read-only for GET requests
- Use for endpoints that serve both purposes

## Error Handling

The middleware will:

- Pass through specific `polis_err_*` errors
- Log detailed error information
- Provide generic `polis_err_participant_creation` for unexpected errors

## Race Condition Handling

The middleware includes robust handling for participant creation race conditions:

- Retries on duplicate key errors
- Re-checks for existing participants after conflicts
- Ensures only one participant per user/conversation pair

## JWT Conversation Scoping

The middleware correctly handles the 4 cases of JWT/conversation mismatches:

1. **Valid Setup** - Token and request for same conversation
2. **Token/XID Match, Wrong Conversation** - Treated as anonymous
3. **Token Wrong, XID for Current** - Uses XID for current conversation
4. **Token Current, XID Wrong** - Treated as anonymous

## Benefits

1. **DRY Principle** - No more duplicated participant management code
2. **Consistency** - All routes handle participants the same way
3. **Maintainability** - Bug fixes and improvements in one place
4. **Clarity** - Route handlers focus on their actual purpose
5. **Testing** - Easier to test participant management separately
6. **Future-Proof** - Easy to add new participant types or auth methods
