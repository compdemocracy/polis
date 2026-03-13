# polismath

The real-time machine learning system powering Polis.

## Development environment

This part of the codebase is implemented in [Clojure](https://clojure.org), a dynamic, data-driven, functional Lisp.
As with any Lisp, Clojure development typically revolves around the interactive REPL.
It's recommended that you use an editor plugin to connect to this REPL, letting you execute and experiment with code as you write it, display documentation, and debug all from the comfort of your favorite text editor.
(See [Calva](https://marketplace.visualstudio.com/items?itemName=betterthantomorrow.calva) for VS, [Fireplace](https://github.com/tpope/vim-fireplace) for Vim, [Cider](https://docs.cider.mx/cider/index.html) for Emacs, [Cursive](https://cursive-ide.com/) for IDEA, etc).

## Quickstart Guide

### Prerequisites

- [Clojure](https://clojure.org/guides/getting_started) installed
- Docker and Docker Compose (recommended for simplest setup)
- Alternatively: PostgreSQL client (`postgresql`, `postgresql-client`) if not using Docker
- A PostgreSQL database instance (either local or remote)

### Setup with Docker (Recommended)

1. **Clone the repository**:

   ```sh
   git clone https://github.com/compdemocracy/polis.git
   cd polis
   ```

2. **Configure environment variables**:
   Create a `.env` file in the root directory with at least:

   ```sh
   DATABASE_URL=postgres://username:password@hostname:port/database
   ```

3. **Start the system with Docker Compose**:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up
   ```

   If this is your first time or you've made changes to Docker files:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up --build
   ```

4. **Connect to the REPL**:
   The nREPL server will be available on port `18975`. Connect to it using your favorite editor's Clojure plugin.

### Setup without Docker

1. **Clone the repository**:

   ```sh
   git clone https://github.com/compdemocracy/polis.git
   cd polis/math
   ```

2. **Configure environment variables**:
   Set at least:

   ```sh
   export DATABASE_URL=postgres://username:password@hostname:port/database
   ```

3. **Start a development REPL**:

   ```sh
   clojure -M:dev
   ```

   This starts an nREPL server but doesn't start the polling system. You can manually start it with `(runner/run!)` from within the REPL.

### Running Commands

The system provides several commands you can run:

```sh
# Get help
clojure -M:run --help

# Export a conversation
clojure -M:run export <conversation-id> -f <export-filename>.zip

# Update a specific conversation
clojure -M:run update -Z <conversation-id>

# Run the full system (poller plus task processing)
clojure -M:run full
```

If using Docker:

```sh
docker compose run math clojure -M:run <command>
```

### Running Tests

```sh
# Run all tests
clojure -M:test

# Or from within a REPL:
(require '[test-runner])
(test-runner/-main)
```

For more information about configuration options, see [the configuration documentation](doc/configuration.md).

## Docker Setup Details

The root directory of this codebase contains docker compose infrastructure for running a complete development environment.
In addition to running the rest of the system's components (database, server, client build processes, etc), it also runs the math component in tandem with an embedded nREPL.
This allows you to connect to and evaluate code from within the running math worker.
To use this infrastructure, run the following from the root of this repository:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up
```

The first time you run this (or if you've edited any of the docker files, or certain other parts of the system), you may need to run this command with the `--build` flag.
In general, this shouldn't be necessary if you're just working on the Clojure code itself, however.

A little while after running this, docker compose will log out a message telling you that the system has started, and that the nREPL server is running on port `18975`.
This message may get quickly swamped out by a stream of other logging messages relaying polling information (TODO: less verbose logging option).
Regardless, at this point, the system is running and can be connected to.
Most editor plugins will connect somewhat automatically if you try to evaluate code or display documentation, but you can refer to the documentation for your editor of choice if this is not the case.

To get a sense for how various parts of these system can be used, take a look at the comment block at the [bottom of `dev/user.clj`](dev/user.clj#L328).

If you're not familiar with Clojure and want a fun crash course, I highly recommend [Clojure for the Brave and True](https://www.braveclojure.com/), a delightful introduction to the language.

## Development Workflow

### Starting and Stopping the System

This application uses Stuart Sierra's Component library for REPL-reloadability.
Sometimes, (e.g.) evaluating a new definition of an existing function will be picked up by the system immediately without any further work.
In other cases though, especially if something stateful is involved, it may be necessary to reload/restart the system.

This can be performed using a set of utility functions in the `polismath.runner` namespace (generally assumed to be aliased to `runner`).
To stop the system, you can use `runner/stop!`, followed by `namespace.repl/refresh` to reload namespaces, and `runner/start!` to start the system back up.
The `runner/system-reset!` function will do all of this for you automatically, but offers less flexibility in specifying configuration details in how you start the system.

While this setup is nice from the perspective of system reloadability, Stuart's Component library unfortunately requires that a lot of the core functions of the system end up having to explicitly accept an argument corresponding to their part of the system.
This ends up being somewhat annoying from the perspective of interactive development, as it requires grabbing the corresponding component out of the `runner/system` map, and passing that to the function in question.
We'll soon be switching to [Mount](https://github.com/tolitius/mount) over Component, for more automated reloadability, and less hassle passing around system/component objects (see [#1056](https://github.com/compdemocracy/polis/issues/1056)).

## Architecture

The system is designed around a polling mechanism which queries the database at a regular interval for new votes and moderation status.
These data are then routed to a "conversation manager", an agent like thing that maintains the current state of the conversation, and orchestrates updates to the data.
The reason for this particular design is that when a conversation is very active, votes can come in at a very rapid rate.
Meanwhile, the time it takes to run an update increases.
We need to have a way of queueing up vote and moderation data updates, so that they're ready to be processed once the last conversation update has completed.

You can see the conversation manager implementation at [`src/polismath/conv_man.clj`](src/polismath/conv_man.clj).

## Logging Configuration

The system's logging level defaults to `:warn` but can be configured in several ways:

1. Set the logging level environment variable:
   - When running directly: use `LOGGING_LEVEL`
   - When using Docker Compose: use `MATH_LOG_LEVEL` (Docker translates this to `LOGGING_LEVEL` internally)

   ```bash
   # When using Docker Compose:
   MATH_LOG_LEVEL=info docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres up
   
   # When running directly:
   export LOGGING_LEVEL=info
   clojure -M:dev
   ```

2. Modify the logging level in `resources/config.edn`

3. Set the level at runtime via the REPL:

   ```clojure
   (require '[taoensso.timbre :as timbre])
   (timbre/set-level! :info)  ; Example of setting to a more verbose level
   ```

Available log levels (from lowest to highest): `:trace`, `:debug`, `:info`, `:warn`, `:error`, `:fatal`, `:report`

## Production setup

The [`docker-compose.yml`](../docker-compose.yml) file in the root of this directory is provided as a basis for production deployment.
Outstanding issues which need to be resolved before it would be ready include ensuring only necessary ports are exposed, etc.
The individual `Dockerfile`s that make up this infrastructure can currently be used by themselves, separate from `docker compose`, for deployment.

## Requirements

Nonetheless, if you wish to run this part of the system directly on a machine (outside of docker), the only requirements are that you:

- [install Clojure](https://clojure.org/guides/getting_started).
- Setup the postgresql client (`sudo apt-get install postgresql postgresql-client` on ubuntu).

If you go this route you will want to take a look at the (see [`doc/configuration.md`](doc/configuration.md)).

## Licensing

Please see LICENSE
