Needed before draft pull request:
* review other differences
Needed before merge:
* Translate and update for all languages
  * s.notificationsGetNotified = "Get periodic updates for this conversation:";
  * s.notificationsEnterEmail = "Enter your email address to receive periodic updates for this conversation:";
  * s.quitForNow = "Quit for now"
  * s.quitForNowYouVotedOnSome = "You have not voted on all the comments."
* replace build:dev with build:prod in file-server/Dockerfile
* Move ctx.showQuitForNowButton to .env
* french(fr): arrête pour l&#39;instant
* use "’" from fr.js to replace "&#39;"
Wanted before merge:
* figure out dev overlay
Code flow:
* voted on all statements:
  *  YOU'VE VOTED ON ALL THE STATEMENTS.
    Enter your email address to get notified when more statements arrive:
* quit for now
  * There are still more statements to vote on.
* Enter at pollForComments
* Jumps to "function done" when no more comments
* try setting ctx.empty to true (call showEmpty; )
