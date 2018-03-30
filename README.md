# polismath

The machine learning and data flow system powering pol.is.


## Setup

To get running, install leinengen 2.
(For more information on using clojure/leiningen, see [the wiki page](https://github.com/pol-is/polismath/wiki/Working-with-clojure).)
From there, all clojure dependencies can be installed using `lein deps`.
You'll also need mongodb and postgresql (client) installed.


## Dev setup

You'll need all of the env variables you would use for the main polis server deployment.
There is a `bin/herokuConfigExport` script that does this for you if you have credential access to a heroku repo with these env variables all set up.
See that script for further instructions.
Also, see the Configuration section of this article for further details about these environment variables.

Once you have all that stuff set up, you an run `lein repl`.
From there you can run `(run! system/poller-system)` to start the poller, and `(stop!)` to stop it
(there is a currently a bug with the stop process, so if you need to stop, just restart the process for now).

This application uses Stuart Sierra's Component library for system management, and places the system in the `system` var.
So if you need to access one of the components that gets passed through to some code in the application for testing, that's where you'll want to grab it.
We'll soon be switching to Mount over Component, for easier interactive devving/REPLing.
But for now...

You can run tests using `lein test`.
Since Clojure is slow to start though, you may find it easier to run the `runner/-main` function (see the `test` directory) from within your REPL process.
There are rough units tests for most of the basic math things, and one or two higher level integration tests.
Looking forward to setting up `clojure.spec` and some generative testing!


## Configuration / Environment variables

There are a number of variables for tuning and tweaking the system, many of which are exposed via environment variables.
The ones you're most likely to need to tweak for one reason or another:

* `MATH_ENV`: This defaults to `dev`, and is not exported by the `herokuConfigExport` script.
  This is meant for local development environments.
  This should be set to `prod` or `preprod` for production and preproduction server environments in particular.
  This flag controls which mongo buckets data gets exported to.
* `INITIAL_POLLING_TIMESTAMP`: This is where the poller starts polling.
  Any conversation which does not have any activity after this timestamp will not be loaded or recomputed.
  However, any conversation which has vote or moderation activity occurring after the given timestamp will be loaded in full.
  This is to prevent old inactive conversations from being loaded into memory every time the poller starts.
  This timestamp is incremented periodically to keep server memory load down.


## Licensing

Please see LICENSE

