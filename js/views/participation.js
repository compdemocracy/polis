var AnalyzeGlobalView = require("../views/analyze-global");
var AnalyzeGroupView = require("../views/analyze-group");
var Backbone = require("backbone");
var eb = require("../eventBus");
var template = require('../tmpl/participation');
var CommentView = require('../views/vote-view');
var CommentFormView = require("../views/comment-form");
var ConversationStatsHeader = require('../views/conversation-stats-header');
var ConversationTabsView = require("../views/conversationTabs");
var ChangeVotesView = require("../views/change-votes");
var LegendView = require("../views/legendView");
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

var SHOULD_AUTO_CLICK_FIRST_COMMENT = false;

var isIE8 = Utils.isIE8();
var isMobile = Utils.isMobile();
var isOldAndroid = Utils.isOldAndroid();
// var useRaphael =
//   isIE8 || // because no support for svg
//   isOldAndroid; // Gingerbread gets no vis.

function shouldHideVisWhenWriteTabShowing() {
  return true;
  // return shouldShowVisUnderTabs();
}


module.exports =  ConversationView.extend({
  name: "participationView",
  template: template,
  className: "participationView",
  events: {
  },
  firstMathPollResultDeferred: $.Deferred(),
  shouldAffixVis: false,
  enableVisAffix: function() {
    this.shouldAffixVis = true;
    $("#visualization_parent_div").addClass("affix");
    $("#visualization_parent_div").css("top", "");    
  },
  disableVisAffix: function() {
    this.shouldAffixVis = false;
    $("#visualization_parent_div").removeClass("affix");
    $("#visualization_parent_div").css("top", $("#vis_sibling_bottom").offset().top);
  },
  onAnalyzeTabPopulated: function() {
    if (SHOULD_AUTO_CLICK_FIRST_COMMENT) {
      $('.query_result_item').first().trigger('click');
    }
  },
  hideVis: function() {
    $(".visualization").hide();
    $(".vis_container").hide();// TODO this is sloppy, should only need to hide/remove a single element
  },
  showVis: function() {
    $(".visualization").show();
    $(".vis_container").show(); // TODO this is sloppy, should only need to hide/remove a single element
  },
  hideWriteHints: function() {
    $("#write_hints_div").hide();
  },
  showWriteHints: function() {
    $("#write_hints_div").show();
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
    ctx.showNewButton = true;
    return ctx;
  },
  changeLegendButtonToShow: function() {
    this.$("#legendToggle").text("show legend");
  },
  changeLegendButtonToHide: function() {
    this.$("#legendToggle").text("hide legend");
  },
  updateLineToSelectedCluster: function(gid) {
    if (this.vis) {
      if (display.xs()) {
        // don't show line on mobile
        this.vis.showLineToCluster(-1);
      } else {
        gid = _.isUndefined(gid) ? this.selectedGid : gid;
        this.vis.showLineToCluster(gid);
      }
    }
  },
  shouldShowVisUnderTabs: function() {
    return (display.xs()/* || display.sm() */) && (this.conversationTabs.onAnalyzeTab() || this.conversationTabs.onGroupTab());
  },
  initialize: function(options) {
    ConversationView.prototype.initialize.apply(this, arguments);
    var that = this;
    var vis;
    var conversation_id = this.conversation_id;
    var pid = this.pid;
    var zinvite = this.zinvite;
    var serverClient = this.serverClient;

    // Hide the Intercom help widget in participation view as soon as possible
    for (var i = 0; i< 1001; i += 100) {
      setTimeout(function() {
        $("#IntercomDefaultWidget").hide();
      }, i);
    }

    eb.on(eb.clusterSelectionChanged, function(gid) {
      that.updateLineToSelectedCluster(gid);
      if (gid === -1) {
        if (vis) {
          vis.selectComment(null);
        }
        // $("#commentViewTab").click();

        if (that.conversationTabs.onGroupTab()) { // TODO check if needed
          that.conversationTabs.gotoVoteTab();
        }
      }
    });

    eb.on(eb.clusterClicked, function(gid) {
      if (_.isNumber(gid) && gid >= 0) {
        that.conversationTabs.gotoGroupTab();
        // $("#groupTab").click();
      // $("#groupTab").tab("show");
      }

      that.onClusterTapped.apply(that, arguments);
    });

    eb.on(eb.queryResultsRendered, this.onAnalyzeTabPopulated.bind(this));


    this.conversationStatsHeader = new ConversationStatsHeader();


    var resultsCollection = new ResultsCollection();

    // HTTP PATCH - model.save({patch: true})

    function onPersonUpdate() {
      that.firstMathPollResultDeferred.resolve();
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
      $("#visualization_div > .visualization").remove();
      // $(VIS_SELECTOR).html("").height(0);
      // $(VIS_SELECTOR).parent().css("display", "none");



      var w = $(VIS_SELECTOR).width();
      if (isIE8) {
        w = 500;
        $(VIS_SELECTOR).width(w);
      }
      var xOffset = display.xs() ? 0 : 30;
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
          isIE8: isIE8,
          isMobile: isMobile,
          getCommentsForProjection: serverClient.getCommentsForProjection,
          getReactionsToComment: serverClient.getReactionsToComment,
          getPidToBidMapping: serverClient.getPidToBidMapping,
          xOffset: xOffset,
          w: w,
          h: h,
          computeXySpans: Utils.computeXySpans,
          el_queryResultSelector: ".query_results_div",
          el: VIS_SELECTOR,
          el_raphaelSelector: VIS_SELECTOR, //"#raphael_div",
      });
      that.updateLineToSelectedCluster();
      vis.selectGroup(that.selectedGid);
      that.disableVisAffix();


      // if (display.xs()) {
      //   $("#commentView").addClass("floating-side-panel-gradients");
      // } else {
      //   $("#commentView").removeClass("floating-side-panel-gradients");
      // }

      that.serverClient.addPersonUpdateListener(onPersonUpdate) // TODO REMOVE DUPLICATE

      that.tutorialController.setHandler("blueDot", function(){
        that.$blueDotPopover = that.$(VIS_SELECTOR).popover({
          title: "DOTS ARE PEOPLE",
          content: "Each dot represents one or more people. The blue circle represents you. By reacting to a comment, you have caused your dot to move. As you and other participants react, you will move closer to people who reacted similarly to you, and further from people who reacted differently. <button type='button' id='blueDotPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
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
          content: "Shaded areas represent groups. Click on a shaded area to show comments that most represent this group's opinion, and separate this group from the other groups.<button type='button' id='shadedGroupPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
          html: true, 
          trigger: "manual",
          placement: "bottom"
        }).popover("show");
        $('#shadedGroupPopoverButton').click(function(){
          that.$shadedGroupPopover.popover("destroy");
        });
      });
      // that.tutorialController.setHandler("analyzePopover", function(){
      //   setTimeout(function(){
      //     if (!that.$el) {
      //       return;
      //     }
      //     that.$analyzeViewPopover = that.$('.query_results > li').first().popover({
      //       title: "COMMENTS FOR THIS GROUP",
      //       content: "Clicking on a shaded area brings up the comments that brought this group together: comments that were agreed upon, and comments that were disagreed upon. Click on a comment to see which participants agreed (green/up) and which participants disagreed (red/down) across the whole conversation. Participants who haven't reacted to the selected comment disappear. <button type='button' id='analyzeViewPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
      //       html: true,
      //       trigger: "manual",
      //       placement: "bottom"  
      //     });
      //     // that.$('.query_result_item').first().trigger('click');
      //     that.$analyzeViewPopover.popover("show");
      //     that.$('#analyzeViewPopoverButton').click(function(){
      //       that.$analyzeViewPopover.popover("destroy");
      //     })      
      //   },1500)
      // }) 

      serverClient.updateMyProjection();
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
        model: new Backbone.Model({
          showTabs: true
        })
      }));



      this.changeVotes = new ChangeVotesView({
        serverClient: serverClient,
        conversation_id: conversation_id
      });

      this.commentView = this.addChild(new CommentView({
        serverClient: serverClient,
        model: new CommentModel(),
        votesByMe: this.votesByMe,
        is_public: Utils.isShortConversationId(this.conversation_id),
        pid: pid,
        conversation_id: conversation_id
      }));
      // this.commentView.on("vote", this.tutorialController.onVote);

      this.commentsByMe = new CommentsCollection({
        conversation_id: conversation_id,
        pid: pid
      });

      this.commentForm = this.addChild(new CommentFormView({
        pid: pid,
        collection: this.commentsByMe,
        conversation_id: conversation_id
      }));

      this.resultsView = this.addChild(new ResultsView({
        serverClient: serverClient,
        conversation_id: conversation_id,
        collection: resultsCollection
      }));

      this.analyzeGroupView = this.addChild(new AnalyzeGroupView({
        conversation_id: conversation_id,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      }));

      this.analyzeGlobalView = this.addChild(new AnalyzeGlobalView({
        conversation_id: conversation_id,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      }));

      this.legendView = this.addChild(new LegendView({
      }));

      var doReproject = _.debounce(serverClient.updateMyProjection, 1000);
      this.analyzeGlobalView.on("searchChanged", function(o) {
        // serverClient.setTidSubsetForReprojection(o.tids);
        if (that.conversationTabs.onAnalyzeTab()) {
          doReproject();
        }
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

      // Wait for PCA to download, so we don't fire an event with only the blue dot.
      // That would cause the vis blocker to flash.
      this.firstMathPollResultDeferred.then(function() {
        that.votesByMe.on("add", updateMyProjectionAfterAddingVote);
      });

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
      moveVisToBottom(); // just in case
      that.showWriteHints();
    });
    that.conversationTabs.on("beforehide:write", function() {
      // When we're leaving the write tab, show the vis again.
      that.showVis();
      that.hideWriteHints();
    });
    that.conversationTabs.on("beforehide:analyze", function() {
      // that.analyzeGlobalView.hideCarousel();
      that.analyzeGlobalView.deselectComments();
      that.disableVisAffix();
    });
    that.conversationTabs.on("beforehide:group", function() {
      // that.analyzeGlobalView.hideCarousel();
      if (vis) {
        vis.deselect();
      }
      that.analyzeGroupView.deselectComments();
      // eb.trigger(eb.commentSelected, false);
      // that.conversationTabs.doShowTabsUX();
    });
    that.conversationTabs.on("beforehide:legend", function() {
      that.changeLegendButtonToShow();
      that.conversationTabs.showTabLabels();
    });
    that.conversationTabs.on("beforeshow:legend", function() {
      that.conversationTabs.hideTabLabels();
      moveVisToBottom();
      that.showVis();
    });

    that.conversationTabs.on("beforeshow:analyze", function() {
      that.enableVisAffix();
      if (that.shouldShowVisUnderTabs()) {
        moveVisAboveQueryResults();
      }
      that.showVis();
      that.allCommentsCollection.doFetch({
        gid: that.selectedGid
      }).then(function() {
        that.analyzeGlobalView.sortAgree();
      });
      // that.analyzeGlobalView.showCarousel();
    });
      that.conversationTabs.on("beforeshow:group", function() {
      if (that.shouldShowVisUnderTabs()) {
        moveVisAboveQueryResults();
      }
      that.showVis();
      that.allCommentsCollection.doFetch({
        gid: that.selectedGid
      }).then(function() {
        that.analyzeGroupView.sortRepness();
      });
      // that.analyzeGlobalView.showCarousel();
    });

    that.conversationTabs.on("beforeshow:vote", function() {
      moveVisToBottom();
      that.showVis();
    });
    that.conversationTabs.on("aftershow:analyze", function() {
      if (SHOULD_AUTO_CLICK_FIRST_COMMENT) {
        $(".query_result_item").first().trigger("click");
      }
    });
    that.conversationTabs.on("aftershow:group", function() {
      $(".query_result_item").first().trigger("click");
    });
    that.conversationTabs.on("aftershow:write", function() {
      // Put the comment textarea in focus (should pop up the keyboard on mobile)
      $("#comment_form_textarea").focus();
    });




    this.listenTo(this, "render", function(){
      setTimeout(function() {

      $("#closeLegendButton").on("click", function() {
        that.conversationTabs.hideLegend();
      });
      $("#legendToggle").on("click", function() {
        that.conversationTabs.toggleLegend();
        if (that.conversationTabs.onLegendTab()) {
          that.changeLegendButtonToHide();
        } else {
          that.changeLegendButtonToShow();
        }
      });

      scrollTopOnFirstShow();


      if (!display.xs() && !display.sm() && that.shouldAffixVis) {
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
      /*
      that.commentView.on("showComment", _.once(function() {
        if (!isMobile) {
          that.$("#"+that.conversationTabs.VOTE_TAB).tooltip({
            title: "Start here - read and react to comments submitted by others.",
            placement: "top",
            delay: { show: 300, hide: 200 },
            container: "body"
          });
        }
      }));
      if (!isMobile) {
        that.$("#" + that.conversationTabs.WRITE_TAB).tooltip({
          title: "If your ideas aren't already represented, submit your own comments. Other participants will be able to react.",
          placement: "top",
          delay: { show: 300, hide: 200 },
          container: "body"
        });
      }

      if (!isMobile) {
        that.$("#"+that.conversationTabs.ANALYZE_TAB).tooltip({
          title: "See which comments have consensus, and which comments were representative of each group.",
          placement: "top",
          delay: { show: 300, hide: 200 },
          container: "body"

        // Wait until the first comment is shown before showing the tooltip
        });
      }
      */
      that.commentView.on("showComment", _.once(function() {   

        that.$commentViewPopover = that.$("#commentView").popover({
          title: "START HERE",
          content: "Read comments submitted by other participants and react using these buttons. <button type='button' id='commentViewPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
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

        // This need to happen quickly, so no debounce
        $(window).resize(function() {
          if (that.shouldShowVisUnderTabs()) {
            // wait for layout
            setTimeout(
              moveVisAboveQueryResults,
              10);
          } else {
            // wait for layout
            setTimeout(
              moveVisToBottom,
              10);
          }
        });
      }




  }, 0); // end listenTo "render"
  });
  this.render();

  // Prefetch the comments to speed up the first click on a group.
  // (we don't want to slow down page load for this, so deferring,
  //  but we don't want to wait until the user clicks the hull)
  setTimeout(function() {
    that.allCommentsCollection.doFetch({});
  }, 3000)

  } // end initialize
});