var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var eb = require("../eventBus");
var template = require('../tmpl/participation');
var CommentView = require('../views/vote-view');
var CommentFormView = require("../views/comment-form");
var ConversationStatsHeader = require('../views/conversation-stats-header');
var ConversationTabsView = require("../views/conversationTabs");
var ChangeVotesView = require("../views/change-votes");
var display = require("../util/display");
var ResultsView = require("../views/results-view");
var VoteModel = require("../models/vote");
var ParticipantModel = require("../models/participant");
var ConversationView = require("../views/conversation");
var CommentModel = require("../models/comment");
var UserModel = require("../models/user");
var CommentsCollection = require("../collections/comments");
var ResultsCollection = require("../collections/results");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");

var VIS_SELECTOR = "#visualization_div";

var isIE8 = Utils.isIE8();
var isMobile = Utils.isMobile();
var isAndroid = Utils.isAndroid();
var useRaphael =
  isIE8 || // because no support for svg
  isAndroid; // because the vis runs a bit slow there. Gingerbread gets no vis.

function shouldShowVisUnderTabs() {
  return display.xs();
}
function shouldHideVisWhenWriteTabShowing() {
  return shouldShowVisUnderTabs();
}


module.exports =  ConversationView.extend({
  name: "participationView",
  template: template,
  events: {
  },
  
  onAnalyzeTabPopulated: function() {
    $('.query_result_item').first().trigger('click');
  },
  hideVis: function() {
    $("#visualization_div").hide();
  },
  showVis: function() {
    $("#visualization_div").show();
  },
  allowMetadataFiltering: function() {
    return this.conversationTabs.onAnalyzeTab();
  },

  emphasizeParticipants: function() {
    if (this.vis) {
      this.vis.emphasizeParticipants.apply(this, arguments);
    }
  },
  context: function() {
    var ctx = ConversationView.prototype.context.apply(this, arguments);
    ctx.use_background_content_class = display.xs();
    ctx.xs = display.xs();
    return ctx;
  },
  initialize: function(options) {
    ConversationView.prototype.initialize.apply(this, arguments);
    var that = this;
    var vis;
    var sid = this.sid;
    var pid = this.pid;
    var zinvite = this.zinvite;
    var serverClient = this.serverClient;


    eb.on(eb.clusterClicked, function() {
      $("#analyzeTab").tab("show");
      that.onClusterTapped.apply(that, arguments);
    });
    eb.on(eb.queryResultsRendered, this.onAnalyzeTabPopulated.bind(this));


    this.conversationStatsHeader = new ConversationStatsHeader();


    var resultsCollection = new ResultsCollection();

    // HTTP PATCH - model.save({patch: true})

    function onPersonUpdate() {
      if (vis) {
        vis.upsertNode.apply(vis, arguments);
      }
    }


    function configureGutters() {     
      if (display.xs()) {
        $("#controlTabs").addClass("no-gutter");
      } else {
        $("#controlTabs").removeClass("no-gutter");        
      }
    }


    function moveVisToBottom() {
      var $vis = that.$(VIS_SELECTOR).detach();
      $("#vis_sibling_bottom").append($vis);
    }

    function moveVisAboveQueryResults() {
      var $vis = that.$(VIS_SELECTOR).detach();
      $("#vis_sibling_above_tab_content").append($vis);
    }


    function initPcaVis() {
      if (!Utils.supportsVis()) {
        // Don't show vis for weird devices (Gingerbread, etc)
        return;
      }

      $(VIS_SELECTOR).html("").height(0);
      // $(VIS_SELECTOR).parent().css("display", "none");



      var w = $(VIS_SELECTOR).width();
      if (isIE8) {
        w = 500;
        $(VIS_SELECTOR).width(w);
      }
      var h = w/2;
      $(VIS_SELECTOR).height(h);
      that.serverClient.removePersonUpdateListener(onPersonUpdate); // TODO REMOVE DUPLICATE
      vis = that.vis = new VisView({
          getPid: function() {
            if (!_.isId(pid)) {
              //alert("bad pid: " + pid);
            }
            return pid;
          },
          isIE8: useRaphael,
          getCommentsForProjection: serverClient.getCommentsForProjection,
          getCommentsForGroup: serverClient.getCommentsForGroup,
          getReactionsToComment: serverClient.getReactionsToComment,
          getPidToBidMapping: serverClient.getPidToBidMapping,
          w: w,
          h: h,
          computeXySpans: Utils.computeXySpans,
          el_queryResultSelector: ".query_results_div",
          el: VIS_SELECTOR,
          el_raphaelSelector: VIS_SELECTOR, //"#raphael_div",
      });



      if (shouldShowVisUnderTabs()) {
        // wait for layout
        setTimeout(
          moveVisToBottom,
          10);
      }

      that.serverClient.addPersonUpdateListener(onPersonUpdate) // TODO REMOVE DUPLICATE

      that.tutorialController.setHandler("blueDot", function(){
        that.$blueDotPopover = that.$(VIS_SELECTOR).popover({
          title: "DOTS ARE PEOPLE",
          content: "Each dot represent one or more people. The blue circle represents you. By reacting to a comment, you have caused your dot to move. As you and other participants react, you will move closer to people who reacted similarly to you, and further from people who reacted differently. <button type='button' id='blueDotPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true,
          trigger: "manual",
          placement: "bottom"
        }).popover("show");
        $('#blueDotPopoverButton').click(function(){
          that.$blueDotPopover.popover("destroy");
        });
      });
      that.tutorialController.setHandler("shadedGroup", function(){
        that.$shadedGroupPopover = that.$(VIS_SELECTOR).popover({
          title: "CLICK ON GROUPS",
          content: "Shaded areas represent groups. Click on a shaded area to show comments that most represent this group's opinion, and separate this group from the other groups.<button type='button' id='shadedGroupPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true, 
          trigger: "manual",
          placement: "bottom"
        }).popover("show");
        $('#shadedGroupPopoverButton').click(function(){
          that.$shadedGroupPopover.popover("destroy");
        });
      });
      that.tutorialController.setHandler("analyzePopover", function(){
        setTimeout(function(){
          if (!that.$el) {
            return;
          }
          that.$analyzeViewPopover = that.$('.query_results > li').first().popover({
            title: "COMMENTS FOR THIS GROUP",
            content: "Clicking on a shaded area brings up the comments that brought this group together: comments that were agreed upon, and comments that were disagreed upon. Click on a comment to see which participants agreed (green/up) and which participants disagreed (red/down) across the whole conversation. Participants who haven't reacted to the selected comment disappear. <button type='button' id='analyzeViewPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
            html: true,
            trigger: "manual",
            placement: "bottom"  
          });
          that.$('.query_result_item').first().trigger('click');
          that.$analyzeViewPopover.popover("show");
          that.$('#analyzeViewPopoverButton').click(function(){
            that.$analyzeViewPopover.popover("destroy");
          })      
        },1500)
      }) 
    } // end initPcaVis  





    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


      /* child views */


      this.conversationTabs = this.addChild(new ConversationTabsView({
        model: new Backbone.Model()
      }));



      this.changeVotes = new ChangeVotesView({
        serverClient: serverClient,
        sid: sid
      });

      this.commentView = this.addChild(new CommentView({
        serverClient: serverClient,
        model: new CommentModel(),
        votesByMe: this.votesByMe,
        is_public:  this.model.get("is_public"),
        pid: pid,
        sid: sid
      }));
      // this.commentView.on("vote", this.tutorialController.onVote);

      this.commentsByMe = new CommentsCollection({
        sid: sid,
        pid: pid
      });

      this.commentForm = this.addChild(new CommentFormView({
        pid: pid,
        collection: this.commentsByMe,
        sid: sid
      }));

      this.resultsView = this.addChild(new ResultsView({
        serverClient: serverClient,
        sid: sid,
        collection: resultsCollection
      }));


      this.analyzeGlobalView = this.addChild(new AnalyzeGlobalView({
        sid: sid,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      }));

      var doReproject = _.debounce(serverClient.updateMyProjection, 1000);
      this.analyzeGlobalView.on("searchChanged", function(o) {
        // serverClient.setTidSubsetForReprojection(o.tids);
        doReproject();
      });

      eb.on(eb.commentSelected, function(tid) {
        if (vis) {
          vis.selectComment(tid);
        }
      });

      // this.votesByMe.on("all", function(x) {
      //   console.log("votesByMe.all", x);
      // });
      // this.votesByMe.on("change", function() {
      //   console.log("votesByMe.change");
      //   serverClient.updateMyProjection(that.votesByMe);
      // });
      var updateMyProjectionAfterAddingVote = _.throttle(function() {
        console.log("votesByMe.add");
        setTimeout(function() {
          serverClient.updateMyProjection(that.votesByMe);
        }, 300); // wait a bit to let the dot blink before moving it.
      }, 200);
      this.votesByMe.on("add", updateMyProjectionAfterAddingVote);

      this.commentForm.on("commentSubmitted", function() {
        // $("#"+VOTE_TAB).tab("show");
      });
   
      this.commentForm.updateCollection();

    // Clicking on the background dismisses the popovers.
    this.$el.on("click", function() {
      that.destroyPopovers();
    });


    that.conversationTabs.on("beforeshow:write", function() {
      if (shouldHideVisWhenWriteTabShowing()) {
        // When we're switching to the write tab, hide the vis.
        that.hideVis();
      }
    });
    that.conversationTabs.on("beforehide:write", function() {
      // When we're leaving the write tab, show the vis again.
      that.showVis();
    });
    that.conversationTabs.on("beforehide:analyze", function() {
      // that.analyzeGlobalView.hideCarousel();
      that.analyzeGlobalView.deselectComments();
    });

    that.conversationTabs.on("beforeshow:analyze", function() {
      if (shouldShowVisUnderTabs()) {
        moveVisAboveQueryResults();
      }
      that.allCommentsCollection.doFetch({
        gid: that.selectedGid
      }).then(function() {
        that.analyzeGlobalView.sort();
      });
      // that.analyzeGlobalView.showCarousel();
    });

    that.conversationTabs.on("beforeshow:vote", function() {
      if (shouldShowVisUnderTabs()) {
        moveVisToBottom();
      }
    });
    that.conversationTabs.on("aftershow:analyze", function() {
      $(".query_result_item").first().trigger("click");
    });

    that.conversationTabs.on("aftershow:write", function() {
      // Put the comment textarea in focus (should pop up the keyboard on mobile)
      $("#comment_form_textarea").focus();
    });




    this.listenTo(this, "render", function(){
      setTimeout(function() {

      scrollTopOnFirstShow();

      if (!display.xs() && !display.sm()) {
        $("#visualization_div").affix({
          offset: {
            top: 150 //will be set dynamically
          }
        });
      }
      function deselectHulls() {
        if (vis) {
          vis.deselect();
        }
      }
      that.conversationTabs.on("analyzeGroups:close", deselectHulls);
      
      that.commentView.on("showComment", _.once(function() {
        if (!isMobile) {
          that.$("#"+that.conversationTabs.VOTE_TAB).tooltip({
            title: "Start here - read and react to comments submitted by others.",
            placement: "top",
            delay: { show: 300, hide: 200 },
            container: "body"
          });
        }
        that.$("#"+that.conversationTabs.VOTE_TAB).on("click", deselectHulls);
      }));
      if (!isMobile) {
        that.$("#" + that.conversationTabs.WRITE_TAB).tooltip({
          title: "If your ideas aren't already represented, submit your own comments. Other participants will be able to react.",
          placement: "top",
          delay: { show: 300, hide: 200 },
          container: "body"
        });
      }
      that.$("#" + that.conversationTabs.WRITE_TAB).on("click", deselectHulls);

      if (!isMobile) {
        that.$("#"+that.conversationTabs.ANALYZE_TAB).tooltip({
          title: "See which comments have consensus, and which comments were representative of each group.",
          placement: "top",
          delay: { show: 300, hide: 200 },
          container: "body"

        // Wait until the first comment is shown before showing the tooltip
        });
      }
      that.commentView.on("showComment", _.once(function() {   

        that.$commentViewPopover = that.$("#commentView").popover({
          title: "START HERE",
          content: "Read comments submitted by other participants and react using these buttons. <button type='button' id='commentViewPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true, //XSS risk, not important for now
          trigger: "manual",
          placement: "bottom"
        });

        setTimeout(function(){
          if (that.conversationTabs.onVoteTab()) {
            that.$commentViewPopover.popover("show");
            $("#commentViewPopoverButton").click(function(){
              that.$commentViewPopover.popover("destroy");
            });
          }
        },2000);
      }));


      
      configureGutters();
      if (isIE8) {
        // Can't listen to the "resize" event since IE8 fires a resize event whenever a DOM element changes size.
        // http://stackoverflow.com/questions/1852751/window-resize-event-firing-in-internet-explorer
       setTimeout(initPcaVis, 10); // give other UI elements a chance to load
        // document.body.onresize = _.debounce(initPcaVis, 1000)
      } else {
        setTimeout(initPcaVis, 10); // give other UI elements a chance to load        
        $(window).resize(_.debounce(function() {
          configureGutters();
          initPcaVis();
        }, 100));
      }




  }, 0); // end listenTo "render"
  });
  this.render();
  } // end initialize
});