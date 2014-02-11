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
          case 1:
            if(hintHandlers.blueDot) {
              hintHandlers.blueDot();
            }
            break;
          case 5:
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
