
# Math worker configuration

This set of documentation is currently incomplete, but describes a couple of the more important bits of configuration in the system.

## Environment variables

There are a number of variables for tuning and tweaking the system, many of which are exposed via environment variables.
Please see [`src/polismath/components/config.clj`](https://github.com/pol-is/polisMath/blob/master/src/polismath/components/config.clj#L51) for the complete listing of environment variables.

The ones you're most frequently to need to tweak for one reason or another:

* `MATH_ENV`: This defaults to `dev`, for local development environments.
  Traditionally we've set this to `prod` and `preprod` for our production and pre-production deployments specifically.
  This value is used in keying the math export json blobs as found in the `math_main` and other tables in the database.
  This makes it possible to run multiple math environments (dev, testing, prod, preprod) all on the same database of votes.
  This setting is something of a relic from an old architecture where prod and preprod environments ran off of the same database, and with the docker infrastructure is generally no longer needed.
  Nevertheless, when you start the math server, you will need to run it with the same `MATH_ENV` setting as you ran the math worker with.
* `POLL_FROM_DAYS_AGO`: This defaults to 10 (at the time of this writing).
  Conversations which have had vote or moderation activity in the specified range will be loaded into memory, and will be updated.
  This prevents old inactive conversations from being loaded into memory every time the poller starts.
  
You'll also need to pass database credentials and such.

* `DATABASE_URL`: url for the database, in heroku format: 
  `postgres://<username>:<password>@<url>:<port>/<database-id>`
* `WEBSERVER_PASS` & `WEBSERVER_USERNAME`, to the polisServer instance, primarily for uathenticated api calls to send
  email notifications to users when their exports are done, via the polisServer.
* `DATABASE_IGNORE_SSL` - certain database deployments (Docker in particular) may not accept ssl

