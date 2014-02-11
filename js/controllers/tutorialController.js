var eb = require("../eventBus");
var $ = require("jquery");

module.exports = function() {

    // var onlyYouAreVisible = false;
    // var thereAreHulls = false;
    // var thereAreBuckets = false;
    // var lookingAtCommentsOverall = false;
    // var lookingAtCommentsOverallCb = $.Callbacks();
    // var lookingAtCommentsForHull = false;
    // var userVotedCb = $.Callbacks();
    var voteCounter = 0;

    eb.on(eb.exitConv, cleanup);
    eb.on(eb.vote, onVote);
    eb.on(eb.clusterClicked, analyzeViewPopover)

    function onVote() {
        voteCounter++;
        console.log('onvote called, votecounter at: ' + voteCounter)

        switch (voteCounter) {
          case 3:
            // Waiting until third comment so that the user knows
            // that the comment in the Read and React pane has changed.
            // Otherwise they may be looking at the help text when
            // the comment changes, and then not realize that the comments
            // in the Read & React pane change.
            if(hintHandlers.blueDot) {
              hintHandlers.blueDot();
            }
            break;
          case 6:
            if(hintHandlers.shadedGroup){
              hintHandlers.shadedGroup();
            }            
            break;
          default:
            break;
        }
    }

    function analyzeViewPopover() {
      if(hintHandlers.analyzePopover){
        hintHandlers.analyzePopover();
      }
    }

    function cleanup() {
      eb.off(eb.exitConv, cleanup);
      eb.off(eb.vote, onVote);
    }

    // mapping from hint name to a single function which shows the hint.
    var hintHandlers = {
    };

    var shown = {
      blueDot: false,
      commentsForHull: false
    };

    function setHintHandler(name, f) {
      hintHandlers[name] = f;
    }

    return {
      setHandler: setHintHandler
    };
  };
