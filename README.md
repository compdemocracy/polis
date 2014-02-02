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
* When impurity is necessary, try to extract as much of the desired functionality as possible into smaller pure functions (this facilitates testing, clarity, and modularity)
* Affix `*` to the end of names of impure functions (particularly anything random)
* Affix `!` to the end of names of functions that specifically change something state
* For now, let's prefer maps over records unless we realize there is a really good reason we should go the other direction (reduces complexity until it doesn't...)

## Storm

Storm can be run by executing `lein run -m storm-spec`.

## Poller

The poller can be run with `lein run -m poller`.
Here's a rough sketch from the JS poller:

    pseudocode sketch:
    endlessly:
      poll:
        fetchreactions:
          votes where create > lasttimestamp order by created
        if reactions: (addToLocalQueue)
          appendToConversation
          updateConversationIds
          update lastVoteTimestamp

