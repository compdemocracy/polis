define([
  "view",
  "templates/comment-view",
  "models/comment",
  "polis"
], function (View, template, CommentModel, serverClient) {
  return View.extend({
    name: "comment-view",
    template: template,
    events: {
      "hover .starbutton": function(){
        this.$('.starbutton').html('<i class="icon-star"></i>');
      }
    },
  initialize: function() {
    var serverClient = this.serverClient;
    console.dir(serverClient);
    var that = this;
    var waitingForComments = true;
    var commentPollInterval = 5 * 1000;
    function pollForComments() {
      if (waitingForComments) {
          serverClient.syncAllCommentsForCurrentStimulus();
      }
    }
    function showComment(model) {
      that.model = new CommentModel(model);
      that.render();
      waitingForComments = false;
    }
    function showNext() {
      serverClient.getNextComment().then(
        showComment,
        function() {
          waitingForComments = true;
          pollForComments();
          that.model = new CommentModel({
            txt: "No comments to show..." // TODO show some indication of whether they should wait around or not (how many active users there are, etc)
          });
          that.render();
      });
    }
    function onFail(err) {
        alert("error sending vote " + JSON.stringify(err));
    }
    this.participantAgreed = function(e) {
      serverClient.agree(this.model.get("tid"))
          .done(showNext)
          .fail(onFail);
    };
    this.participantDisagreed = function(tid) {
      serverClient.disagree(this.model.get("tid"))
          .done(showNext)
          .fail(onFail);
    };
    this.participantPassed = function(tid) {
      serverClient.pass(this.model.get("tid"))
          .done(showNext)
          .fail(onFail);
    };
    this.participantStarred = function(tid) {
      $.when(serverClient.star(this.model.get("tid")), serverClient.agree(this.model.get("tid")))
          .done(showNext)
          .fail(onFail);
    };
    this.participantTrashed = function(tid) {
      serverClient.trash(this.model.get("tid"))
          .done(showNext)
          .fail(onFail);
    };
    showNext();
    serverClient.addCommentsAvailableListener(function() {
      if (waitingForComments) {
        showNext();
      }
    });
    pollForComments(); // call immediately
    setInterval(pollForComments, commentPollInterval);
    this.listenTo(this, "rendered", function(){
      this.$("#agreeButton").tooltip({
        title: "This comment represents my opinion",
        placement: "right",
        delay: { show: 500, hide: 0 },
      });
      this.$("#disagreeButton").tooltip({
        title: "This comment does not represent my opinion",
        placement: "top",
        delay: { show: 500, hide: 0 },
      });
      this.$("#passButton").tooltip({
        title: "'No reaction', or 'I am unsure'",
        placement: "left",
        delay: { show: 500, hide: 0 },
      });
      this.$("#starButton").tooltip({
        title: "'Critical point', or 'central to my worldview'",
        placement: "right",
        delay: { show: 500, hide: 0 },
      });
      this.$("#trashButton").tooltip({
        title: "This comment is irrelevant and/or abusive",
        placement: "left",
        delay: { show: 500, hide: 0 },
      });
    });
  }
  });
});
