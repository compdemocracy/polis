
# Math worker configuration

This set of documentation is currently incomplete, but describes a couple of the more important bits of configuration in the system.

## Environment variables

There are a number of variables for tuning and tweaking the system, many of which are exposed via environment variables.
Please see [`src/polismath/components/config.clj`](https://github.com/pol-is/polisMath/blob/master/src/polismath/components/config.clj#L51) for the complete listing of environment variables.

The ones you're most frequently to need to tweak for one reason or another:

* **`MATH_ENV`**: This defaults to `dev`, for local development environments.
  Traditionally we've set this to `prod` and `preprod` for our production and pre-production deployments specifically.
  This value is used in keying the math export json blobs as found in the `math_main` and other tables in the database.
  This makes it possible to run multiple math environments (dev, testing, prod, preprod) all on the same database of votes.
  This setting is something of a relic from an old architecture where prod and preprod environments ran off of the same database, and with the docker infrastructure is generally no longer needed.
  Nevertheless, when you start the math server, you will need to run it with the same **`MATH_ENV`** setting as you ran the math worker with.
* **`POLL_FROM_DAYS_AGO`**: This defaults to 10 (at the time of this writing).
  Conversations which have had vote or moderation activity in the specified range will be loaded into memory, and will be updated.
  This prevents old inactive conversations from being loaded into memory every time the poller starts.

You'll also need to pass database credentials. If using docker compose, this will be inherited from the `.env` file or process environment in which docker is being run.

  **`DATABASE_URL`**: url for the database:

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
