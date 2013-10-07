define([
  'view',
  'templates/comment-view',
  'models/comment',
  'polis'
], function (View, template, CommentModel, serverClient) {
  return View.extend({
    name: 'comment-view',
    template: template,
    events: {
    "hover .starbutton": function(){
      this.$('.starbutton').html('<i class="icon-star"></i>')
    },
    "ready": function(){
      this.$('#agreeButton').tooltip({
          placement: "right",
          title: "This comment represents my opinion",
      })
    }
  },
  initialize: function() {
    var serverClient = this.serverClient;
    console.dir(serverClient)
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
    };
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
    };
    function onFail(err) {
        alert('error sending vote ' + err);
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
  

  }
  });
});
