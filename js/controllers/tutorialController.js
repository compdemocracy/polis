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
    var clusterHasBeenClicked = false;

    eb.on(eb.exitConv, cleanup);
    eb.on(eb.vote, onVote);
    eb.on(eb.clusterClicked, onClusterClicked)

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
            if(hintHandlers.blueDot && !shown.blueDot) {
              hintHandlers.blueDot();
              shown.blueDot = true;
            }
            break;
          case 6:
            if(hintHandlers.shadedGroup && !shown.shadedGroup && !clusterHasBeenClicked){
              hintHandlers.shadedGroup();
              shown.shadedGroup = true;
            }
            break;
          default:
            break;
        }
    }


    function onClusterClicked() {
      clusterHasBeenClicked = true;
      if(hintHandlers.analyzePopover && !shown.analyzePopover){
        hintHandlers.analyzePopover();
        shown.analyzePopover = true;
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
      analyzePopover: false,
      blueDot: false,
      shadedGroup: false
    };

    function setHintHandler(name, f) {
      hintHandlers[name] = f;
    }

    return {
      setHandler: setHintHandler
    };
  };
