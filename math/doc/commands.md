# Polismath Commands Guide

This document provides detailed information about the commands and options available for running the Polismath system.

## Clojure CLI Commands

The Polismath project uses several Clojure CLI commands for different purposes:

### Common Command Flags

- **`-A`**: Specifies an alias for dependency resolution and classpath configuration
- **`-M`**: Specifies an alias AND runs the `-main` function in the namespace specified by the alias
- **`-P`**: Prepares/downloads dependencies without running any code (a.k.a. "prep")

### Common Commands Used in the Project

- **`clojure -A:dev -P`**: Used in the Dockerfile to download dependencies specified by the `:dev` alias without running code
- **`clojure -M:dev`**: Starts an nREPL server with development dependencies
- **`clojure -M:run <subcommand>`**: Runs the specified subcommand through the runner system
- **`clojure -M:test`**: Runs the test suite

## Available Subcommands

The Polismath system provides several subcommands that run different components or operations:

| Subcommand | System Type | Description |
|------------|-------------|-------------|
| `update-all` | base-system | Updates all conversations in the database |
| `update` | base-system | Updates a specific conversation by ID |
| `poller` | poller-system | Runs the polling system to watch for new votes and moderation |
| `tasks` | task-system | Runs the task system for auxiliary jobs |
| `full` | full-system | Runs both poller and task systems together |
| `export` | export-system | Exports conversation data to files |

These subcommands are defined in the `polismath.runner` namespace, with execution paths determined by the `-main` function.

## Command-Line Options

### General Options (Most Commands)

```txt
-r, --recompute         Recompute conversations from scratch instead of starting from most recent values
-h, --help              Print help and exit
-z, --zid ZID           ZID (conversation ID) to operate on
-Z, --zinvite ZINVITE   ZINVITE code (short code) of conversation to operate on
```

### Export-Specific Options

The `export` command has many additional options:

```txt
-z, --zid ZID                 ZID on which to do an export
-Z, --zinvite ZINVITE         ZINVITE code on which to perform an export
-X, --include-xid             Include user xids in output
-u, --user-id USER_ID         Export all conversations associated with USER_ID, and place in zip file
-f, --filename FILENAME       Name of output file (should be zip for csv out)
-t, --at-time AT_TIME         A string of YYYY-MM-DD-HH-MM-SS (in UTC) or ms-timestamp since epoch
-T, --at-times AT_TIMES       A vector of strings of --at-time format
-F, --format FORMAT           Either csv or json
-M, --update-math             Update math
-P, --update-postgres         Update postgres
-h, --help                    Print help and exit
```

## Running Commands from the REPL

When working with the REPL, you can run and manage systems directly using functions in the `polismath.runner` namespace. This approach provides more flexibility and interactive development capabilities.

### Starting and Stopping Systems

```clojure
;; First require the runner namespace and system definitions
(require '[polismath.runner :as runner]
         '[polismath.system :as system])

;; Run the full system (poller + tasks)
(runner/run! system/full-system)

;; Run with configuration overrides
(runner/run! system/full-system {:poll-from-days-ago 0.1})

;; Run just the poller system
(runner/run! system/poller-system)

;; Run the export system
(runner/run! system/export-system)

;; Stop any running system
(runner/stop!)

;; Reset the system (stops, reloads code, and restarts)
(runner/system-reset!)
```

### Working with Conversations

```clojure
;; Load a conversation by ID
(def conv (conv-man/load-or-init (:conversation-manager runner/system) 12345))

;; Update a conversation
(def updated-conv (conv/conv-update conv []))

;; Queue updates for a conversation
(conv-man/queue-message-batch! (:conversation-manager runner/system)
                                :votes
                                12345
                                [])
```

### Running Tests in the REPL

```clojure
;; Run the test suite directly
(require '[test-runner])
(test-runner/-main)

;; Run a specific test namespace
(require '[clojure.test :as test])
(test/run-tests 'conversation-test)
```

### Lifecycle Management

The REPL approach lets you start, modify, and restart components of the system without restarting your entire application:

```clojure
;; Initialize a system but don't start it
(runner/init! system/base-system)

;; Start the system
(runner/start!)

;; Stop the system
(runner/stop!)

;; Make code changes...

;; Reload code and restart
(require '[clojure.tools.namespace.repl :as namespace.repl])
(namespace.repl/refresh)
(runner/start!)

;; Or use the combined reset function
(runner/system-reset!)
```

## Examples

### Running the Full System

To run both the poller and tasks systems:

```sh
clojure -M:run full
```

### Updating a Specific Conversation

Update a conversation by ZID (numeric ID):

```sh
clojure -M:run update -z 12345
```

Or by ZINVITE (short code):

```sh
clojure -M:run update -Z abc123
```

### Running with Docker Compose

With Docker Compose, you can run commands within the math container:

```sh
docker compose run math clojure -M:run <subcommand>
```

### Exporting Data

Export a conversation to a zip file:

```sh
clojure -M:run export -z 12345 -f export.zip
```

Export all conversations for a user:

```sh
clojure -M:run export -u 67890 -f user-exports.zip
```

Export a conversation at a specific point in time:

```sh
clojure -M:run export -Z abc123 -t 2023-01-15-12-00-00 -f historical.zip
```

### System Timeout and Restart

The `bin/run` script uses a timeout mechanism to automatically restart the system every 4 hours:

```sh
timeout -s KILL 14400 clojure -M:run full
```

This runs the full system for up to 4 hours (14400 seconds), then kills it and restarts. This prevents memory leaks and ensures the system stays healthy during long-running operations.

## Getting Help

To see available options for any command:

```sh
clojure -M:run --help
```

For export-specific help:

```sh
clojure -M:run export --help
```

## Running Tests

To run the test suite:

```sh
clojure -M:test
```

Or from within a REPL:

```clojure
(require '[test-runner])
(test-runner/-main)
```
