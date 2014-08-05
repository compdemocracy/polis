var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/vote-view");
var CommentModel = require("../models/comment");
var serverClient = require("../lib/polis");

module.exports = Handlebones.ModelView.extend({
    name: "vote-view",
    template: template,
    events: {

      "click #agreeButton": "participantAgreed",
      "click #disagreeButton": "participantDisagreed",
      "click #passButton": "participantPassed",
      
      "hover .starbutton": function(){
        this.$(".starbutton").html("<i class='fa fa-star'></i>");
      }
    },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    return ctx;
  },
  animateOut: function() {
    // Animating opacity directly instead of jQuery's fadeOut because we don't want display:none at the end.
    this.$el.children().children().animate({
      opacity: 0
    }, 200);
  },
  animateIn: function() {
    this.$el.children().children().animate({
      opacity: 1
    }, 200);
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
      eb.on(eb.exitConv, cleanup);
    function cleanup() {
      //alert('cleanup');
      eb.off(eb.exitConv, cleanup);
    }
    var serverClient = options.serverClient;
    var votesByMe = options.votesByMe;
    var votesByMeFetched = $.Deferred();

    var is_public = options.is_public;
    var conversation_id = this.conversation_id = options.conversation_id;
    var pid = this.pid = options.pid;
    console.dir(serverClient);

    if (this.pid < 0) {
      // DEMO_MODE
      votesByMeFetched.resolve();
    }
    votesByMe.on("sync", votesByMeFetched.resolve);


    var that = this;
    var waitingForComments = true;
    var commentPollInterval = 5 * 1000;
    function pollForComments() {
      if (waitingForComments) {
          getNextAndShow();
      }
    }
    function showComment(model) {
      that.model.set(_.extend({
        empty: false
      }, model));
      that.render();
      that.trigger("showComment");
      waitingForComments = false;
    }
    function getNextAndShow() {
      var params = {};
      if (this.model && this.model.get("tid")) {
        params.notTid = this.model.get("tid");
      }
      serverClient.getNextComment(params).then(function(c) {
        if (c && c.txt) {
          showComment(c);
        } else {
          showEmpty();
        }
      });
    }
    function onFail(err) {
      this.animateIn();
      console.error(err);
      alert("Apologies, your vote failed to send. Please check your connection and try again.");
    }
    function onVote(result) {
      var that = this;
      eb.trigger(eb.vote);
      if (result.nextComment) {
        showComment(result.nextComment);
      } else {
        showEmpty();
      }
      this.animateIn();

      // Fix for stuck hover effects for touch events.
      // Remove when this is fix is accepted
      // https://github.com/twbs/bootstrap/issues/12832
      this.$(".btn-vote").blur();
    }
    function showEmpty() {
      var userHasVoted = !!votesByMe.size();

      waitingForComments = true;
      // pollForComments();

      var message1;
      var message2;
      if (userHasVoted) {
        message1 = "You've voted on all the comments.";
        message2 = "You can write your own by clicking the Write tab.";
      } else {
        message1 = "There aren't any comments yet.";
        if (is_public) {
          message2 =  "Get this conversation started by inviting more participants, or add your own comment in the 'write' tab.";
        } else {
          message2 =  "Get this conversation started by adding your own comment in the 'write' tab.";
        }
      }

      // TODO show some indication of whether they should wait around or not (how many active users there are, etc)
      that.model.set({
        empty: true,
        txt1: message1,
        txt2: message2
      });
      that.render();
    }

    this.onButtonClicked = function() {
      this.animateOut();
    };

    this.participantAgreed = function(e) {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: -1,
        conversation_id: conversation_id,
        pid: pid,
        tid: tid
      });
      this.onButtonClicked();
      serverClient.agree(tid)
          .then(onVote.bind(this), onFail.bind(this));
    };
    this.participantDisagreed = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: 1,
        conversation_id: conversation_id,
        pid: pid,
        tid: tid
      });
      this.onButtonClicked();
      serverClient.disagree(tid)
          .then(onVote.bind(this), onFail.bind(this));
    };
    this.participantPassed = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        vote: 0,
        conversation_id: conversation_id,
        pid: pid,
        tid: tid
      });
      this.onButtonClicked();
      serverClient.pass(tid)
          .then(onVote.bind(this), onFail.bind(this));
    };
    this.participantStarred = function() {
      var tid = this.model.get("tid");
      votesByMe.add({
        participantStarred: true,
        vote: -1,
        conversation_id: conversation_id,
        pid: pid,
        tid: tid
      });
      this.onButtonClicked();
      $.when(serverClient.star(tid), serverClient.agree(tid))
          .then(onVote.bind(this), onFail.bind(this));
    };
    this.participantTrashed = function() {
      var tid = this.model.get("tid");
      this.onButtonClicked();
      serverClient.trash(tid)
          .then(onVote.bind(this), onFail.bind(this));
    };

    pollForComments(); // call immediately
    setInterval(pollForComments, commentPollInterval);
    this.listenTo(this, "rendered", function(){
      // this.$("#agreeButton").tooltip({
      //   title: "This comment represents my opinion",
      //   placement: "right",
      //   delay: { show: 500, hide: 0 },
      //   container: "body"
      // });
      // this.$("#disagreeButton").tooltip({
      //   title: "This comment does not represent my opinion",
      //   placement: "top",
      //   delay: { show: 500, hide: 0 }
      // });
      this.$("#passButton").tooltip({
        title: "'No reaction', or 'I am unsure'",
        placement: "top",
        delay: { show: 500, hide: 0 }
      });
      this.$("#starButton").tooltip({
        title: "'Critical point', or 'central to my worldview'",
        placement: "top",
        delay: { show: 500, hide: 0 },
        container: "body"
      });
      this.$("#trashButton").tooltip({
        title: "This comment is irrelevant and/or abusive",
        placement: "top",
        delay: { show: 500, hide: 0 }
      });

      
    });
  }
  });