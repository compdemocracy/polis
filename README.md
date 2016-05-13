# polismath - the math module!

Welcome to teh mathz behind pol.is.

## Setup

To get running, install leinengen 2.
(For more information on using clojure/leiningen, see [the wiki page](https://github.com/metasoarous/polismath/wiki/Working-with-clojure).)
From there, all clojure dependencies can be installed using `lein deps`.
You'll also need mongodb and postgresql (client) installed.

## Storm

Storm can be run by executing `lein run -m polismath.stormspec`.
There are a number of options available for this, which can be shown by adding `-h` to the end.
In particular though, `-r` triggers a recompute of the all conversations (without loading the previous states from mongo).

## Licensing

Please see LICENSE

