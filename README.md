# polisDeployment

How to deploy Polis

## Setting up the database and polis server

For this see the instructions at <https://github.com/pol-is/polisServer>.

## Setting up the math worker

Once you've got that running you should be able to set up the math worker as seen here: <https://github.com/pol-is/polisMath>.

Note however that you may have to first run `ALTER TABLE math_main ADD COLUMN caching_tick bigint;` in postgres for polisMath to work properly (see https://github.com/pol-is/issues/issues/87).

## More to come...

Please check back soon, and feel free to PR if you have anything to add.

