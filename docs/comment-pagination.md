# Comment Pagination

The Comments API (`GET /api/v3/comments`) supports optional pagination for efficiently retrieving large comment lists.

## Backwards Compatibility

The API maintains backwards compatibility:

- **Without pagination parameters**: Returns a plain array of comments (legacy behavior)
- **With pagination parameters**: Returns an object with `comments` array and `pagination` metadata

## Usage

### Pagination Parameters

| Parameter | Type | Default | Maximum | Description |
|-----------|------|---------|---------|-------------|
| `limit` | number | 50 | 500 | Number of comments to return per page |
| `offset` | number | 0 | - | Number of comments to skip |

To enable pagination, include the `limit` parameter in your request.

## Examples

### Legacy Format (Without Pagination)

**Request:**

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj
```

**Response:**

```json
[
  {
    "tid": 1,
    "txt": "First comment",
    "created": 1640000000000,
    "is_seed": false,
    "is_meta": false,
    "lang": "en",
    "pid": 42
  },
  {
    "tid": 2,
    "txt": "Second comment",
    "created": 1640000100000,
    "is_seed": false,
    "is_meta": false,
    "lang": "en",
    "pid": 43
  }
]
```

### Paginated Format

**Request (First Page):**

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj&limit=50&offset=0
```

**Response:**

```json
{
  "comments": [
    {
      "tid": 1,
      "txt": "First comment",
      "created": 1640000000000,
      "is_seed": false,
      "is_meta": false,
      "lang": "en",
      "pid": 42
    },
    {
      "tid": 2,
      "txt": "Second comment",
      "created": 1640000100000,
      "is_seed": false,
      "is_meta": false,
      "lang": "en",
      "pid": 43
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 150,
    "hasMore": true
  }
}
```

**Request (Second Page):**

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj&limit=50&offset=50
```

**Response:**

```json
{
  "comments": [
    {
      "tid": 51,
      "txt": "Comment 51",
      "created": 1640005000000,
      "is_seed": false,
      "is_meta": false,
      "lang": "en",
      "pid": 92
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 50,
    "total": 150,
    "hasMore": true
  }
}
```

**Request (Last Page):**

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj&limit=50&offset=100
```

**Response:**

```json
{
  "comments": [
    {
      "tid": 150,
      "txt": "Last comment",
      "created": 1640015000000,
      "is_seed": false,
      "is_meta": false,
      "lang": "en",
      "pid": 142
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 100,
    "total": 150,
    "hasMore": false
  }
}
```

## Pagination Metadata

The `pagination` object contains:

| Field | Type | Description |
|-------|------|-------------|
| `limit` | number | Number of items returned in this page |
| `offset` | number | Number of items skipped |
| `total` | number | Total number of comments available |
| `hasMore` | boolean | Whether there are more comments after this page |

## Implementation Notes

- All other comment filtering parameters (`moderation`, `mod`, `mod_gt`, `modIn`, `tids`, etc.) work with pagination
- The `limit` parameter is capped at 500 to prevent excessive resource usage
- The `offset` defaults to 0 if not provided

### Default Limits for Non-Paginated Requests

The API applies different default limits depending on the type of request:

- **Moderation requests** (`moderation=true`): **No default limit** - returns ALL comments matching the filter criteria. This allows administrators to view and manage all comments that need moderation, regardless of count.
- **Non-moderation requests**: Default limit of **999 comments** for backwards compatibility with legacy behavior.

**Example of non-limited moderation request:**

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj&moderation=true&mod=-1
```

This will return all rejected comments (could be 3000+) without pagination.

To limit moderation requests, explicitly include the `limit` parameter:

```http
GET /api/v3/comments?conversation_id=2kz3n5hkpj&moderation=true&mod=-1&limit=50
```
