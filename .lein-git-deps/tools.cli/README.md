# tools.cli

Tools for working with command line arguments.

## Stable Releases and Dependency Information

The 0.3.x series of tools.cli features a new flexible API, better adherence
to GNU option parsing conventions, and ClojureScript support.

[Leiningen](https://github.com/technomancy/leiningen) dependency information:

    [org.clojure/tools.cli "0.3.1"]

[Maven](http://maven.apache.org/) dependency information:

    <dependency>
      <groupId>org.clojure</groupId>
      <artifactId>tools.cli</artifactId>
      <version>0.3.1</version>
    </dependency>

The function `clojure.tools.cli/cli` has been superseded by
`clojure.tools.cli/parse-opts`, and should not be used in new programs.

The previous function will remain for the forseeable future. It has also been
adapted to use the new tokenizer, so upgrading is still worthwhile even if you
are not ready to migrate to `parse-opts`.

## Quick Start

```clojure
(ns my.program
  (:require [clojure.tools.cli :refer [parse-opts]])
  (:gen-class))

(def cli-options
  ;; An option with a required argument
  [["-p" "--port PORT" "Port number"
    :default 80
    :parse-fn #(Integer/parseInt %)
    :validate [#(< 0 % 0x10000) "Must be a number between 0 and 65536"]]
   ;; A non-idempotent option
   ["-v" nil "Verbosity level"
    :id :verbosity
    :default 0
    :assoc-fn (fn [m k _] (update-in m [k] inc))]
   ;; A boolean option defaulting to nil
   ["-h" "--help"]])

(defn -main [& args]
  (parse-opts args cli-options))
```

Execute the command line:

    my-program -vvvp8080 foo --help --invalid-opt

to produce the map:

```clojure
{:options   {:port 8080
             :verbosity 3
             :help true}

 :arguments ["foo"]

 :summary   "  -p, --port PORT  80  Port number
               -v                   Verbosity level
               -h, --help"

 :errors    ["Unknown option: \"--invalid-opt\""]}
```

**Note** that exceptions are _not_ thrown on parse errors, so errors must be
handled explicitly after checking the `:errors` entry for a truthy value.

Please see the [example program](#example-usage) for a more detailed example
and refer to the docstring of `parse-opts` for comprehensive documentation:

http://clojure.github.io/tools.cli/index.html#clojure.tools.cli/parse-opts

## New Features in 0.3.x

### Better Option Tokenization

In accordance with the [GNU Program Argument Syntax Conventions][GNU], two
features have been added to the options tokenizer:

* Short options may be grouped together.

  For instance, `-abc` is equivalent to `-a -b -c`. If the `-b` option
  requires an argument, the same `-abc` is interpreted as `-a -b "c"`.

* Long option arguments may be specified with an equals sign.

  `--long-opt=ARG` is equivalent to `--long-opt "ARG"`.

  If the argument is omitted, it is interpreted as the empty string.
  e.g. `--long-opt=` is equivalent to `--long-opt ""`

[GNU]: https://www.gnu.org/software/libc/manual/html_node/Argument-Syntax.html

### In-order Processing for Subcommands

Large programs are often divided into subcommands with their own sets of
options. To aid in designing such programs, `clojure.tools.cli/parse-opts`
accepts an `:in-order` option that directs it to stop processing arguments at
the first unrecognized token.

For instance, the `git` program has a set of top-level options that are
unrecognized by subcommands and vice-versa:

    git --git-dir=/other/proj/.git log --oneline --graph

By default, `clojure.tools.cli/parse-opts` interprets this command line as:

    options:   [[--git-dir /other/proj/.git]
                [--oneline]
                [--graph]]
    arguments: [log]

When :in-order is true however, the arguments are interpreted as:

    options:   [[--git-dir /other/proj/.git]]
    arguments: [log --oneline --graph]

Note that the options to `log` are not parsed, but remain in the unprocessed
arguments vector. These options could be handled by another call to
`parse-opts` from within the function that handles the `log` subcommand.

### Options Summary

`parse-opts` returns a minimal options summary string:

      -p, --port NUMBER  8080       Required option with default
          --host HOST    localhost  Short and long options may be omitted
      -d, --detach                  Boolean option
      -h, --help

This may be inserted into a larger usage summary, but it is up to the caller.

If the default formatting of the summary is unsatisfactory, a `:summary-fn`
may be supplied to `parse-opts`. This function will be passed the sequence
of compiled option specification maps and is expected to return an options
summary.

The default summary function `clojure.tools.cli/summarize` is public and may
be useful within your own `:summary-fn` for generating the default summary.

### Option Argument Validation

There is a new option entry `:validate`, which takes a tuple of
`[validation-fn validation-msg]`. The validation-fn receives an option's
argument *after* being parsed by `:parse-fn` if it exists.

    ["-p" "--port PORT" "A port number"
     :parse-fn #(Integer/parseInt %)
     :validate [#(< 0 % 0x10000) "Must be a number between 0 and 65536"]]

If the validation-fn returns a falsy value, the validation-msg is added to the
errors vector.

### Error Handling and Return Values

Instead of throwing errors, `parse-opts` collects error messages into a vector
and returns them to the caller. Unknown options, missing required arguments,
validation errors, and exceptions thrown during `:parse-fn` are all added to
the errors vector.

Correspondingly, `parse-opts` returns the following map of values:

    {:options     A map of default options merged with parsed values from the command line
     :arguments   A vector of unprocessed arguments
     :summary     An options summary string
     :errors      A vector of error messages, or nil if no errors}

During development, parse-opts asserts the uniqueness of option `:id`,
`:short-opt`, and `:long-opt` values and throws an error on failure.

### ClojureScript Support

The `cljs.tools.cli` namespace is available for use in ClojureScript programs!
Both `parse-opts` and `summarize` have been ported, and have complete feature
parity with their Clojure counterparts.

ClojureScript Versions `0.0-2080` and above are supported, but earlier
versions are likely to work as well.

## Example Usage

```clojure
(ns cli-example.core
  (:require [cli-example.server :as server]
            [clojure.string :as string]
            [clojure.tools.cli :refer [parse-opts]])
  (:import (java.net InetAddress))
  (:gen-class))

(def cli-options
  [;; First three strings describe a short-option, long-option with optional
   ;; example argument description, and a description. All three are optional
   ;; and positional.
   ["-p" "--port PORT" "Port number"
    :default 80
    :parse-fn #(Integer/parseInt %)
    :validate [#(< 0 % 0x10000) "Must be a number between 0 and 65536"]]
   ["-H" "--hostname HOST" "Remote host"
    :default (InetAddress/getByName "localhost")
    ;; Specify a string to output in the default column in the options summary
    ;; if the default value's string representation is very ugly
    :default-desc "localhost"
    :parse-fn #(InetAddress/getByName %)]
   ;; If no required argument description is given, the option is assumed to
   ;; be a boolean option defaulting to nil
   [nil "--detach" "Detach from controlling process"]
   ["-v" nil "Verbosity level; may be specified multiple times to increase value"
    ;; If no long-option is specified, an option :id must be given
    :id :verbosity
    :default 0
    ;; Use assoc-fn to create non-idempotent options
    :assoc-fn (fn [m k _] (update-in m [k] inc))]
   ["-h" "--help"]])

(defn usage [options-summary]
  (->> ["This is my program. There are many like it, but this one is mine."
        ""
        "Usage: program-name [options] action"
        ""
        "Options:"
        options-summary
        ""
        "Actions:"
        "  start    Start a new server"
        "  stop     Stop an existing server"
        "  status   Print a server's status"
        ""
        "Please refer to the manual page for more information."]
       (string/join \newline)))

(defn error-msg [errors]
  (str "The following errors occurred while parsing your command:\n\n"
       (string/join \newline errors)))

(defn exit [status msg]
  (println msg)
  (System/exit status))

(defn -main [& args]
  (let [{:keys [options arguments errors summary]} (parse-opts args cli-options)]
    ;; Handle help and error conditions
    (cond
      (:help options) (exit 0 (usage summary))
      (not= (count arguments) 1) (exit 1 (usage summary))
      errors (exit 1 (error-msg errors)))
    ;; Execute program with options
    (case (first arguments)
      "start" (server/start! options)
      "stop" (server/stop! options)
      "status" (server/status! options)
      (exit 1 (usage summary)))))
```

## Developer Information

* [GitHub project](https://github.com/clojure/tools.cli)
* [Bug Tracker](http://dev.clojure.org/jira/browse/TCLI)
* [Continuous Integration](http://build.clojure.org/job/tools.cli/)
* [Compatibility Test Matrix](http://build.clojure.org/job/tools.cli-test-matrix/)

## Change Log

* Release 0.3.1 on 2014-01-02
  * Apply patch for [TCLI-8](http://dev.clojure.org/jira/browse/TCLI-8):
    Correct test that trivially always passes
  * Apply patch for [TCLI-7](http://dev.clojure.org/jira/browse/TCLI-7):
    summarize throws when called with an empty sequence of options
* Release 0.3.0 on 2013-12-15
  * Add public functions `parse-opts` and `summarize` to supersede `cli`,
    addressing [TCLI-3](http://dev.clojure.org/jira/browse/TCLI-3),
    [TCLI-4](http://dev.clojure.org/jira/browse/TCLI-4), and
    [TCLI-6](http://dev.clojure.org/jira/browse/TCLI-6)
  * Add ClojureScript port of `parse-opts` and `summarize`, available in
    `cljs.tools.cli`.
  * Move extra documentation of `cli` function to
    https://github.com/clojure/tools.cli/wiki/Documentation-for-0.2.4
* Release 0.2.4 on 2013-08-06
  * Applying patch for [TCLI-2](http://dev.clojure.org/jira/browse/TCLI-2)
    (support an assoc-fn option)
* Release 0.2.3 on 2013-08-06
  * Add optional description string to prefix the returned banner
* Release 0.2.2 on 2012-08-09
  * Applying patch for [TCLI-1](http://dev.clojure.org/jira/browse/TCLI-1)
    (do not include keys when no value provided by :default)
* Release 0.2.1 on 2011-11-03
  * Removing the :required option. Hangover from when -h and --help were
    implemented by default, causes problems if you want help and dont
    provide a :required argument.
* Release 0.2.0 on 2011-10-31
  * Remove calls to System/exit
  * Remove built-in help options
* Release 0.1.0
  * Initial import of Clargon codebase

## License

Copyright (c) Rich Hickey and contributors. All rights reserved.

The use and distribution terms for this software are covered by the
Eclipse Public License 1.0 (http://opensource.org/licenses/eclipse-1.0.php)
which can be found in the file epl.html at the root of this distribution.
By using this software in any fashion, you are agreeing to be bound by
the terms of this license.

You must not remove this notice, or any other, from this software.
