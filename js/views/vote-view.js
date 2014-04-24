var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/vote-view");
var CommentModel = require("../models/comment");
var serverClient = require("../lib/polis");

module.exports = Handlebones.ModelView.extend({
    name: "vote-view",
    template: template,
    events: {
      "hover .starbutton": function(){
        this.$(".starbutton").html("<i class='icon-star'></i>");
      }
    },
  context: function() {
    return _.extend({}, this, this.model&&this.model.attributes);
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
    votesByMe.on("sync", votesByMeFetched.resolve);
    var is_public = options.is_public;
    var zid = this.zid = options.zid;
    var pid = this.pid = options.pid;
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
      that.model.set(_.extend({
        empty: false
      }, model));
      that.render();
      that.trigger("showComment");
      waitingForComments = false;
    }
    function showNext() {
      serverClient.getNextComment().then(
        showComment,
        function() {
          votesByMeFetched.done(function() {
            var userHasVoted = !!votesByMe.size();

            waitingForComments = true;
            pollForComments();
            
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
        });
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
          .then(onVote, onFail);
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
          .then(onVote, onFail);
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
          .then(onVote, onFail);
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
          .then(onVote, onFail);
    };
    this.participantTrashed = function() {
      var tid = this.model.get("tid");
      serverClient.trash(tid)
          .then(onVote, onFail);
    };
    showNext();
    serverClient.addCommentsAvailableListener(function() {
      if (waitingForComments) {
        showNext();
      }
    });
    
    this.$el.on("click", function(e) {
      e.preventDefault();
      console.dir(e.target);
      var id = e.target.id;
      if (id === "agreeButton") {
        that.participantAgreed();
      } else if (id === "disagreeButton") {
        that.participantDisagreed();
      } else if(id === "trashButton") {
        that.participantTrashed();
      } else if (id === "starButton") {
        that.participantStarred();
      } else if (id === "passButton") {
        that.participantPassed();
      }
    });

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