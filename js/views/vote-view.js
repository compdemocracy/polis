var eb = require("../eventBus");
var View = require("../view");
var template = require("../tmpl/vote-view");
var CommentModel = require("../models/comment");
var serverClient = require("../lib/polis");

module.exports = View.extend({
    name: "vote-view",
    template: template,
    events: {
      "hover .starbutton": function(){
        this.$(".starbutton").html("<i class='icon-star'></i>");
      }
    },
  initialize: function(options) {
      eb.on(eb.exitConv, cleanup);
    function cleanup() {
      //alert('cleanup');
      eb.off(eb.exitConv, cleanup);
    }
    var serverClient = this.serverClient;
    var votesByMe = this.votesByMe;
    var zid = this.zid;
    var pid = this.pid;
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
    function onVote() {
      eb.trigger(eb.vote);
      showNext();
    };
    this.participantAgreed = function(e) {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: -1,
        zid: zid,
        pid: pid,
        tid: tid
      });
      serverClient.agree(tid)
          .done(onVote)
          .fail(onFail);
    };
    this.participantDisagreed = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: 1,
        zid: zid,
        pid: pid,
        tid: tid
      });
      serverClient.disagree(tid)
          .done(onVote)
          .fail(onFail);
    };
    this.participantPassed = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: 0,
        zid: zid,
        pid: pid,
        tid: tid
      });
      serverClient.pass(tid)
          .done(onVote)
          .fail(onFail);
    };
    this.participantStarred = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        participantStarred: true,
        vote: -1,
        zid: zid,
        pid: pid,
        tid: tid
      });
      $.when(serverClient.star(tid), serverClient.agree(tid))
          .done(showNext)
          .fail(onFail);
    };
    this.participantTrashed = function() {
      var tid = this.model.get("tid");
      serverClient.trash(tid)
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
        container: "body"
      });
      this.$("#disagreeButton").tooltip({
        title: "This comment does not represent my opinion",
        placement: "top",
        delay: { show: 500, hide: 0 }
      });
      this.$("#passButton").tooltip({
        title: "'No reaction', or 'I am unsure'",
        placement: "left",
        delay: { show: 500, hide: 0 }
      });
      this.$("#starButton").tooltip({
        title: "'Critical point', or 'central to my worldview'",
        placement: "right",
        delay: { show: 500, hide: 0 },
        container: "body"
      });
      this.$("#trashButton").tooltip({
        title: "This comment is irrelevant and/or abusive",
        placement: "left",
        delay: { show: 500, hide: 0 }
      });
    });
  }
  });