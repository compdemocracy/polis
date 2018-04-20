# polismath

The machine learning and data flow system powering pol.is.


## Setup

To get running, you'll need to [install Leinengen](https://github.com/technomancy/leiningen) (v at least 2.0).
From there, all clojure dependencies can be installed using `lein deps`.
However, you'll also need the postgresql (client) installed (sudo `apt-get install postgresql postgresql-client` on ubuntu).


## Configuration / Environment variables

There are a number of variables for tuning and tweaking the system, many of which are exposed via environment variables.
The ones you're most frequently to need to tweak for one reason or another:

* `MATH_ENV`: This defaults to `dev`, for local development environments.
  Traditionally we've set this to `prod` and `preprod` for our production and pre-production deployments specifically.
  This value is used in keying the math export json blobs as found in the `math_main` and other tables in the database.
  This makes it possible to run multiple math environments (dev, testing, prod, preprod) all on the same database of votes.
  When you start the math server, you will need to run it with the same `MATH_ENV` setting as you ran the math worker with.
* `POLL_FROM_DAYS_AGO`: This defaults to 10 (at the time of this writing).
  Conversations which have had vote or moderation activity in the specified range will be loaded into memory, and will be updated.
  This prevents old inactive conversations from being loaded into memory every time the poller starts.
  
You'll also need to pass database credentials and such.

Please see [`src/polismath/components/config.clj`](https://github.com/pol-is/polisMath/blob/master/src/polismath/components/config.clj#L51) for the complete listing of environment variables.
Some of these are a little out of date, so bare with us as we clean house and clarify documentation there.


## Dev setup

Once you have all that stuff set up, you an run `lein repl`.
From there you can run `(run! system/poller-system)` to start the poller, and `(stop!)` to stop it.

This application uses Stuart Sierra's Component library for REPL-reloadability, and places the system in the `system` var.
So if you need to access one of the components that gets passed through to some code in the application for testing, that's where you'll want to grab it.
We'll soon be switching to Mount over Component, for more automated reloadability, and less hassle having to pass around and think about the system object to test things.

To see some example REPL usage, take a look at the comment block at the [bottom of `dev/user.clj`](https://github.com/pol-is/polisMath/blob/master/dev/user.clj#L328).

You can run tests using `lein test`.
Since Clojure is slow to start though, you may find it easier to run the `runner/-main` function (see the `test` directory) from within your REPL process.
There is an example of this in the `dev/user.clj` file above.
There are rough units tests for most of the basic math things, and one or two higher level integration tests.
Looking forward to setting up `clojure.spec` and some generative testing!

If you're not familiar with Clojure, you may wish to take a look at the Clojure related [wiki pages](https://github.com/pol-is/polisMath/wiki).


## Licensing

Please see LICENSE

