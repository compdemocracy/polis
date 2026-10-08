# DynamoDB Error Handling Solution

## Problem

The Polis server was experiencing crashes when accessing DynamoDB for report narrative generation. The primary issues were:

1. **Server crashes when DynamoDB tables don't exist** - The `DynamoStorageService.initTable()` method throws unhandled errors
2. **Inconsistent error handling** - Some methods catch errors but don't propagate them properly
3. **Poor error messages** - Users get generic errors instead of helpful guidance
4. **No graceful degradation** - Server crashes instead of returning meaningful error responses

## Root Cause

The `DynamoStorageService` class in `server/src/utils/storage.ts` had inconsistent error handling:

- `initTable()` throws errors when tables don't exist, crashing the server
- Other methods like `putItem()`, `queryItemsByRidSectionModel()` catch errors but don't re-throw them
- No standardized error types or messages

## Solution Implementation

### 1. Enhanced Storage Service Error Handling

**File:** `server/src/utils/storage.ts`

Key improvements made:

- Added `StorageError` interface for standardized error handling
- Created `createStorageError()` method to categorize error types
- Added `logError()` method for consistent, detailed error logging
- Modified `initTable()` to return results instead of throwing errors
- Updated all methods to return `{ success: boolean; error?: StorageError; data?: any }` format

**Error Categories:**

- `isTableNotFound` - Table doesn't exist (needs Delphi pipeline run)
- `isCredentialsError` - AWS credential issues
- `isNetworkError` - Connection problems
- `isPermissionError` - Access denied

### 2. Graceful Error Handling in Report Narrative

**File:** `server/src/routes/reportNarrative.ts`

Key changes needed:

- Wrap `storage.initTable()` in try-catch
- Check `initResult.success` before proceeding
- Return appropriate HTTP status codes (503 for service unavailable)
- Provide helpful error messages with hints for resolution

### 3. Example Error Handling Pattern

```typescript
// Initialize storage with improved error handling
try {
  const initResult = await storage.initTable();
  if (!initResult.success) {
    const error = initResult.error!;
    logger.error("Failed to initialize storage:", error);
    
    if (error.isTableNotFound) {
      failJson(res, 503, "polis_err_report_storage_not_ready", {
        hint: "The report storage system is not fully initialized. Please try again later or contact support if this persists."
      });
    } else if (error.isCredentialsError) {
      failJson(res, 503, "polis_err_report_storage_config", {
        hint: "Storage service configuration error. Please contact support."
      });
    } else if (error.isNetworkError) {
      failJson(res, 503, "polis_err_report_storage_network", {
        hint: "Cannot connect to storage service. Please try again later."
      });
    } else {
      failJson(res, 503, "polis_err_report_storage", {
        hint: "Storage service error. Please try again later."
      });
    }
    return;
  }
} catch (error) {
  logger.error("Storage initialization failed:", error);
  failJson(res, 503, "polis_err_report_storage", {
    hint: "Storage service error. Please try again later."
  });
  return;
}
```

## Benefits

1. **No more server crashes** - All DynamoDB errors are caught and handled gracefully
2. **Helpful error messages** - Users get specific guidance on what went wrong
3. **Better debugging** - Detailed error logging with context
4. **Graceful degradation** - Service returns meaningful HTTP responses instead of crashing
5. **Consistent error handling** - All storage operations follow the same pattern

## Error Scenarios Handled

| Error Type | HTTP Status | User Message | Admin Action |
|------------|-------------|--------------|--------------|
| Table Not Found | 503 | "Storage system not initialized" | Run Delphi pipeline or create tables |
| Credentials Error | 503 | "Configuration error" | Check AWS credentials |
| Network Error | 503 | "Connection error" | Check DynamoDB endpoint accessibility |
| Permission Error | 503 | "Access error" | Review IAM permissions |
| Unknown Error | 503 | "Storage service error" | Check logs for details |

## Testing

To test the error handling:

1. **Table not found**: Access report with non-existent DynamoDB table
2. **Credentials error**: Use invalid AWS credentials
3. **Network error**: Point to unreachable DynamoDB endpoint
4. **Permission error**: Use credentials without DynamoDB access

Expected behavior: Service returns 503 with helpful error message instead of crashing.

## Monitoring

Monitor these log patterns:

- `DynamoDB [operation] error:` - Storage operation failures
- `Storage initialization failed:` - Critical initialization issues
- `Failed to initialize storage:` - Table access problems

## Future Improvements

1. Add retry logic for transient errors
2. Implement circuit breaker pattern for repeated failures
3. Add health check endpoint for storage service status
4. Consider fallback modes when storage is unavailable
