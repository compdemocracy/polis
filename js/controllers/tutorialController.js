define([
  "jquery"
], function (
  $
) {
  return function() {
    // var onlyYouAreVisible = false;
    // var thereAreHulls = false;
    // var thereAreBuckets = false;
    // var lookingAtCommentsOverall = false;
    // var lookingAtCommentsOverallCb = $.Callbacks();
    // var lookingAtCommentsForHull = false;
    var userVotedCb = $.Callbacks();

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
      alert("user voted");
    });
    return {
      onVote: userVotedCb.fire
    };
  };
});