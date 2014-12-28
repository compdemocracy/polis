# polismath - the math module!

Welcome to teh mathz.

Let's use the [github issues](https://github.com/metasoarous/polismath/issues) for discussing issues -- both technical and theoretic -- and the [github wiki](https://github.com/metasoarous/polismath/wiki/_pages) for collating/synthesizing this and other useful information.

## Setup

To get running, install leinengen 2.
(For more information on using clojure/leiningen, see [the wiki page](https://github.com/metasoarous/polismath/wiki/Working-with-clojure).)
From there, all clojure dependencies can be installed using `lein deps`.
You'll also need mongodb and postgresql (client) installed.

## Coding Style

* Emphasis on pure functions wherever possible
* When impurity is necessary, try to extract as much of the desired functionality as possible into smaller pure functions (facilitating testing, clarity, and modularity)
* Affix `!` to the end of names of functions that change state
* Prefer maps over records unless there is a good not to
* Use `#(...)` candied functions only when one liners; `(fn [..] ...)` otherwise

## Storm

Storm can be run by executing `lein run -m polismath.stormspec`.
There are a number of options available for this, which can be shown by adding `-h` to the end.
In particular though, `-r` triggers a recompute of the all conversations (without loading the previous states from mongo).

