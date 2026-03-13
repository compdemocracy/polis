# Polismath Configuration Guide

This document provides detailed information about configuring the Polismath service, the mathematical backend for the Polis system.

## Configuration Methods

The Polismath service can be configured in several ways:

1. **Environment Variables** (primary method)
2. **Configuration File** (resources/config.edn - secondary)
3. **Runtime Configuration** (via REPL)

Configuration values are merged in the following order of precedence (highest to lowest):

1. Runtime overrides
2. Environment variables
3. Configuration file
4. Default values

## Required Configuration

At minimum, you need to provide:

  `postgres://<username>:<password>@<url>:<port>/<database-id>`

## Database Connection Pooling

The math service now uses HikariCP for enhanced connection pooling, which significantly improves performance under concurrent workloads (such as during testing).

* **`DATABASE_POOL_SIZE`**: Maximum number of connections in the pool (default: 10)
  * For development: 5-10 connections
  * For testing: 8-15 connections  
  * For production: 10-20 connections (adjust based on load)

The connection pool automatically:

* Maintains a minimum number of idle connections (25% of max pool size)
* Validates connections before use with `SELECT 1`
* Detects and prevents connection leaks
* Optimizes prepared statement caching
* Handles connection timeouts and retries gracefully

### Connection Pool Monitoring

The service logs connection pool configuration at startup and provides health check functionality. Connection failures are automatically retried up to 3 times with exponential backoff.
- **Database Connection**: The database URL for connecting to PostgreSQL

## Environment Variables

Environment variables are the primary method for configuring the system. When using Docker Compose, these can be set in a `.env` file at the project root.

### Database Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string in the format `postgres://username:password@hostname:port/database` | None (Required) |
| `DATABASE_POOL_SIZE` | Connection pool size | 3 |
| `DATABASE_IGNORE_SSL` | Whether to ignore SSL for database connections | false |
| `DATABASE_FOR_READS_NAME` | Database name for read operations if different | None |

### Environment Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LOGGING_LEVEL` | Logging level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `report`) | `warn` |
| `POLL_FROM_DAYS_AGO` | How far back to poll for conversation updates (in days) | 10 |

> **Note:** When using Docker Compose, use `MATH_LOG_LEVEL` instead of `LOGGING_LEVEL`. Docker Compose translates this to `LOGGING_LEVEL` internally.

### Polling Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `VOTE_POLLING_INTERVAL` | Interval for polling votes (milliseconds) | 1000 |
| `MOD_POLLING_INTERVAL` | Interval for polling moderation actions (milliseconds) | 1000 |
| `MATH_ZID_BLOCKLIST` | Comma-separated list of conversation IDs to block from processing | None |
| `MATH_ZID_ALLOWLIST` | Comma-separated list of conversation IDs to exclusively process | None |

### Math Processing Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `MATH_MATRIX_IMPLEMENTATION` | Matrix implementation to use (`vectorz` recommended) | `vectorz` |
| `MATH_CUTOFF_MEDIUM` | Maximum size before running in medium mode | None |
| `MATH_CUTOFF_LARGE` | Maximum size before running in large mode | None |
| `MATH_CUTOFF_MAX_PTPTS` | Maximum participants before rejecting new participants | None |
| `MATH_CUTOFF_MAX_CMNTS` | Maximum comments before rejecting new comments | None |
| `RECOMPUTE` | Whether to recompute conversations from scratch | false |

### Export Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPORT_EXPIRY_DAYS` | Days before exported data expires | 6 |
| `EXPORT_SERVER_AUTH_USERNAME` | Username for export server authentication | None |
| `EXPORT_SERVER_AUTH_PASS` | Password for export server authentication | None |

## Setting Environment Variables

### Docker Environment

With Docker Compose, you can use a `.env` file:

```sh
DATABASE_URL=postgres://username:password@hostname:port/database
MATH_LOG_LEVEL=info  # Docker Compose translates this to LOGGING_LEVEL
```

Then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up
```

### Direct Environment

When running without Docker, set environment variables directly:

```bash
export DATABASE_URL=postgres://username:password@hostname:port/database
export LOGGING_LEVEL=info  # Use LOGGING_LEVEL directly when not using Docker Compose
clojure -M:dev
```

## Runtime Configuration

When using the REPL, you can override configuration when starting the system:

```clojure
(require '[polismath.runner :as runner]
         '[polismath.system :as system])

;; Run with custom configuration
(runner/run! system/full-system 
  {:poll-from-days-ago 0.1})
```

## Logging Configuration

The system uses Timbre for logging. You can configure it in several ways:

1. Set the environment variable:
   - When running directly: use `LOGGING_LEVEL`
   - When using Docker Compose: use `MATH_LOG_LEVEL` (Docker translates this to `LOGGING_LEVEL` internally)

2. Configure at runtime:

   ```clojure
   (require '[taoensso.timbre :as log])
   (log/set-level! :debug)  ;; Set to debug level
   ```

Available log levels (from least to most verbose):

- `:report`
- `:fatal`
- `:error`
- `:warn` (default)
- `:info`
- `:debug`
- `:trace`

You can also configure logging to output to a file by setting the `LOGGING_FILE` environment variable.

## Advanced Configuration

For more advanced configuration options, see the `rules` map in [src/polismath/components/config.clj](../src/polismath/components/config.clj).

## System Components

The Polismath system consists of several components that can be configured and started independently:

- **Base System**: Core functionality without polling
- **Poller System**: Base system plus database polling for votes and moderation
- **Task System**: Handles auxiliary tasks like exports
- **Full System**: Combines poller and task systems

To run a specific subsystem, use:

```clojure
;; In REPL
(runner/run! system/poller-system)

;; Or via command line
clojure -M:run poller
```
