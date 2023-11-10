Needed before merge:
* Translate and update for all languages
  * s.notificationsGetNotified = "Get periodic updates for this conversation:";
  * s.notificationsEnterEmail = "Enter your email address to receive periodic updates for this conversation:";
  * s.quitForNow = "Quit for now"
  * s.quitForNowYouVotedOnSome = "You have not voted on all the comments."
* replace build:dev with build:prod in file-server/Dockerfile
* Move ctx.showQuitForNowButton to .env
* use "’" from fr.js to replace "&#39;"
*
Wanted before merge:
* figure out dev overlay and 'make DEV start'
