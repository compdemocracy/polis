var eb = require("../eventBus");
var $ = require("jquery");

module.exports = function() {

    // var onlyYouAreVisible = false;
    // var thereAreHulls = false;
    // var thereAreBuckets = false;
    // var lookingAtCommentsOverall = false;
    // var lookingAtCommentsOverallCb = $.Callbacks();
    // var lookingAtCommentsForHull = false;
    var userVotedCb = $.Callbacks();
    eb.on(eb.exit, cleanup);
    eb.on(eb.vote, userVotedCb.fire);
   // eb.on(eb.vote, function() {
    //  alert(1);
    //});
    //    eb.on(eb.exit, function() {
    //  alert(2);
    //});
    function cleanup() {
      eb.off(eb.exit, cleanup);
      eb.off(eb.vote, onVote);
    }

    var hintHandlers = {
    };

    var shown = {
      blueDot: false,
      commentsForHull: false
    };

    // $.get("/tutorialState").then(function(data) {
    //   shown = $.extend(shown, data);
    //   start();
    //  });


    // function onCommentsOverallShown(el) {
    //   lookingAtCommentsOverall = true;
    //   lookingAtCommentsOverallCb.fire(el);
    // }

    // function showBlueDotHint() {
    //   if (!onlyYouAreVisible) {
    //     params.showBlueDotHint();
    //   }
    // }
    // userVotedCb.add(function() { userHasVoted = true; });
    // userVotedCb.add(showBlueDotHint);
    userVotedCb.add(function() {
      if (hintHandlers.blueDot) {
        hintHandlers.blueDot("Dots represent people. The blue dot is you.</br>");
      }
    });

    function setHintHandler(name, f) {
      hintHandlers[name] = f;
    }

    return {
      setHandler: setHintHandler
    };
  };
