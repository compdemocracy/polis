var AnalyzeGlobalView = require("../views/analyze-global");
var AnalyzeGroupView = require("../views/analyze-group");
var Backbone = require("backbone");
var eb = require("../eventBus");
var template = require('../tmpl/participation');
var ReadReactView = require('../views/ReadReactView');
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
var UserModel = require("../models/user");
var CommentsCollection = require("../collections/comments");
var ResultsCollection = require("../collections/results");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");
var VoteMoreView = require("../views/voteMoreView");
var TutorialView = require("../views/tutorialView");
var TutorialSlidesView = require("../views/tutorialSlides");
var WritingTipsView = require("../views/writingTips");

var VIS_SELECTOR = "#visualization_div";

var SHOULD_AUTO_CLICK_FIRST_COMMENT = false;

var VIS_MODE_VIS = 0;
var VIS_MODE_WAITING = 1;
var VIS_MODE_VOTEMORE = 2;
var VIS_MODE_TUT = 3;

var useAboveVisTutorial = false;
var useVisBlockingTutorial = true; 
var launchWithTutorial = false; // !Utils.isInIframe(); // Don't want to show tutorial for casual/journalism scenarios until we have the custom wording/logic to wait on a first vote.
var useVoteMoreBlocker = false;

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
  inVisLegendCounter: 0,
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
    $("#vis_sibling_bottom").hide();
  },
  showVis: function() {
    $("#vis_sibling_bottom").show();
  },
  showTutorial: function() {
    if (this.visModeModel.get("visMode") === VIS_MODE_TUT) {
      $("#tutorialSlides").show();
    }
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

  updateVoteRemaining: function() {
    if (useVoteMoreBlocker) {
      this.voteMoreModel.set("remaining", Math.max(0, 2 - this.votesByMe.length));
    }
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
  updateVisMode: function() {
    if (!this.vis) {
      return;
    }
    if (this.voteMoreModel.get("remaining") >= 1) {
      this.visModeModel.set("visMode", VIS_MODE_VOTEMORE);
    } else if (false) { // TODO

    } else {
      this.visModeModel.set("visMode", VIS_MODE_VIS);
    }
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

    // initialize this first to ensure that the vote view is showing and populated ASAP
    this.readReactView = this.addChild(new ReadReactView({
      firstCommentPromise: options.firstCommentPromise,
      serverClient: serverClient,
      model: new Backbone.Model(),
      conversationModel: this.model,
      votesByMe: this.votesByMe,
      // is_public: Utils.isShortConversationId(this.conversation_id),
      pid: pid,
      conversation_id: conversation_id
    }));

    // clicks to "the background" should delelect hulls.
    // This is important because the edge of the vis is not visible.
    $(document.body).on("click", function(e) {
      if ($(e.target).hasClass("clickDeselectsHull")) {
        if (that.vis) {
          that.vis.deselect();
        }
      }
    });

    eb.on(eb.deselectGroups, function() {
      if (that.vis) {
        that.vis.deselect();
      }
    });

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
        if (that.tutorialView) {
          that.tutorialView.endAnalyzeTutorial();
        }
      }
    });

    eb.on(eb.clusterClicked, function(gid) {
      if (_.isNumber(gid) && gid >= 0) {
        that.conversationTabs.gotoGroupTab();
        // that.tutorialModel.set("step", Infinity);
        // $("#groupTab").click();
      // $("#groupTab").tab("show");

        if (that.selectedGid === -1) {
          // on transition from no selection to selection
          if (that.tutorialView) {
            that.tutorialView.startAnalyzeTutorial();
          }
        }
      }

      that.onClusterTapped.apply(that, arguments);
    });

    eb.on(eb.queryResultsRendered, this.onAnalyzeTabPopulated.bind(this));


    this.conversationStatsHeader = new ConversationStatsHeader();


    var resultsCollection = new ResultsCollection();

    // HTTP PATCH - model.save({patch: true})

    function onPersonUpdate(updatedNodes, newClusters, newParticipantCount) {
      that.firstMathPollResultDeferred.resolve();
      if (vis) {
        vis.upsertNode.apply(vis, arguments);
      }
      $(".participationCount").html(newParticipantCount + (newParticipantCount === 1 ? " person" : " people"));
    }


    function configureGutters() {     
      if (display.xs()) {
        $("#controlTabs").addClass("no-gutter");
      } else {
        $("#controlTabs").removeClass("no-gutter");        
      }
    }


    function moveVisToBottom() {
      var $vis = that.$("#visualization_parent_div").detach();
      $("#vis_sibling_bottom").append($vis);
    }

    function moveVisAboveQueryResults() {
      var $vis = that.$("#visualization_parent_div").detach();
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



      var w = $("#visualization_div").width();
      var xOffset = 30;
      if (isIE8) {
        w = 500;
        // $("#visualization_div").width(w);
      }
      if (display.xs()) {
        xOffset = 0;
        w = $(document.body).width() - 30;
      }
      var h = w/2;
      // $("#visualization_div").height(h);
      that.serverClient.removePersonUpdateListener(onPersonUpdate); // TODO REMOVE DUPLICATE
      vis = that.vis = new VisView({
          inVisLegendCounter: that.inVisLegendCounter,
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
      if (that.selectedGid >= 0) {
        vis.selectGroup(that.selectedGid);
      }
      that.disableVisAffix();

      // if (display.xs()) {
      //   $("#commentView").addClass("floating-side-panel-gradients");
      // } else {
      //   $("#commentView").removeClass("floating-side-panel-gradients");
      // }

      that.serverClient.addPersonUpdateListener(onPersonUpdate) // TODO REMOVE DUPLICATE

      // that.tutorialController.setHandler("blueDot", function(){
      //   that.$blueDotPopover = that.$(VIS_SELECTOR).popover({
      //     title: "DOTS ARE PEOPLE",
      //     content: "Each dot represents one or more people. The blue circle represents you. By reacting to a comment, you have caused your dot to move. As you and other participants react, you will move closer to people who reacted similarly to you, and further from people who reacted differently. <button type='button' id='blueDotPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
      //     html: true,
      //     trigger: "manual",
      //     placement: "bottom"
      //   }).popover("show");
      //   $('#blueDotPopoverButton').click(function(){
      //     that.$blueDotPopover.popover("destroy");
      //   });
      // });
      // that.tutorialController.setHandler("shadedGroup", function(){
      //   that.$shadedGroupPopover = that.$(VIS_SELECTOR).popover({
      //     title: "CLICK ON GROUPS",
      //     content: "Shaded areas represent groups. Click on a shaded area to show comments that most represent this group's opinion, and separate this group from the other groups.<button type='button' id='shadedGroupPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
      //     html: true, 
      //     trigger: "manual",
      //     placement: "bottom"
      //   }).popover("show");
      //   $('#shadedGroupPopoverButton').click(function(){
      //     that.$shadedGroupPopover.popover("destroy");
      //   });
      // });
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

      // serverClient.updateMyProjection();
    } // end initPcaVis  

    this.initPcaVis = initPcaVis;




    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


      /* child views */
      this.tutorialModel = new Backbone.Model({
        visible: false,
        paused: false,
        step: useAboveVisTutorial ? 1 : Infinity
      });
      this.tutorialModel.on("change:step", function() {
        var step = that.tutorialModel.get("step");
        if (step === 1) {
          that.vis.showHintYou();
        } else {
          that.vis.hideHintYou();
        }
        if (step === 2) {
          that.vis.showHintOthers();
        } else {
          that.vis.hideHintOthers();
        }
      });

      if (launchWithTutorial && !_.isUndefined(options.finishedTutorial)) {
        launchWithTutorial = !options.finishedTutorial;
      }
      var mode = VIS_MODE_VIS;
      if (useVoteMoreBlocker) {
        mode = VIS_MODE_VOTEMORE;
      } else if (launchWithTutorial) {
        mode = VIS_MODE_TUT;
      } else {
        mode = VIS_MODE_VIS;
      }
      this.visModeModel = new Backbone.Model({
        visMode: -1
      });
      this.visModeModel.on("change:visMode", function() {
        var visMode = that.visModeModel.get("visMode");
        if (visMode === VIS_MODE_TUT) {
          $("#tutorialSlides").show();
          $("#afterTutorial").hide();
          $("#voteMoreParent").hide();
          $("#visualization_parent_div").hide();
          // hide others
        }
        if (visMode === VIS_MODE_VIS) {
          // that.vis.hideHintVoteMoreBlocker();
          $("#voteMoreParent").hide();
          $("#tutorialSlides").hide();
          $("#afterTutorial").show();
          $("#visualization_parent_div").css("visibility", "visible");
          $("#visualization_parent_div").css("display", "block");
          $("#visualization_div").css("display", "block");
          $("#visualization_parent_div").fadeIn();
          that.tutorialModel.set("visible", true);
          that.initPcaVis();
          // hide others
        }
        if (visMode === VIS_MODE_WAITING) {
          that.tutorialModel.set("visible", false);
          $("#voteMoreParent").hide();
          $("#visualization_parent_div").fadeOut();
          // hide others
        }
        if (visMode === VIS_MODE_VOTEMORE) {
          // that.vis.showHintVoteMoreBlocker();
          $("#voteMoreParent").fadeIn();
          $("#visualization_parent_div").fadeOut();
          that.tutorialModel.set("visible", false);
          // hide others

        }
      });


      if (useVisBlockingTutorial) {
        this.tutorialSlidesModel = new Backbone.Model({
          step: 1
        });
        this.tutorialSlidesView = this.addChild(new TutorialSlidesView({
          model: this.tutorialSlidesModel
        }));
        this.tutorialSlidesView.on("done", function() {
          that.visModeModel.set("visMode", VIS_MODE_VIS);
          that.serverClient.finishedTutorial();
        });
      }
      setTimeout(function() {
        if (mode === VIS_MODE_TUT) {
          tutorialStart();
        } else {
          that.visModeModel.set("visMode", mode);
        }
      },1);


      this.voteMoreModel = new Backbone.Model({
        remaining: 0
      });
      this.voteMoreView = this.addChild(new VoteMoreView({
        model: this.voteMoreModel
      }));

      if (useAboveVisTutorial) {
        this.tutorialView = this.addChild(new TutorialView({
          model: this.tutorialModel
        }));
      }

      this.conversationTabs = this.addChild(new ConversationTabsView({
        model: new Backbone.Model({
          showTabs: true
        })
      }));

      this.writingTips = this.addChild(new WritingTipsView());

      this.changeVotes = new ChangeVotesView({
        serverClient: serverClient,
        conversation_id: conversation_id
      });

      // this.commentView.on("vote", this.tutorialController.onVote);

      this.commentsByMe = new CommentsCollection({
        conversation_id: conversation_id,
        pid: pid
      });

      this.commentForm = this.addChild(new CommentFormView({
        pid: pid,
        model: new Backbone.Model({}),
        conversationModel: this.model,
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
        getParticipantsOfInterestForGid: function() {
          return that.serverClient.getParticipantsOfInterestForGid.apply(0, arguments);          
        },
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        getGroup: function() {
          return that.serverClient.getGroup.apply(0, arguments);          
        },
        getLocations: function() {
          return that.serverClient.getLocations.apply(0, arguments);
        },
        collection: this.allCommentsCollection
      }));

      this.analyzeGlobalView = this.addChild(new AnalyzeGlobalView({
        conversation_id: conversation_id,
        getTidsForConsensus: function() {
          return that.serverClient.getTidsForConsensus.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      }));

      this.legendView = this.addChild(new LegendView({
      }));

      this.voteMoreModel.on("change", function() {
        that.updateVisMode();
      });

      that.updateVoteRemaining();
      that.votesByMe.on("sync", function() {
        that.updateVoteRemaining();
      });
      that.votesByMe.on("change", function() {
        that.updateVoteRemaining();
      });
      that.votesByMe.on("add", function() {
        that.updateVoteRemaining();
      });


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

    that.conversationTabs.on("beforeshow:analyze", function() {
      that.showTutorial();
      // that.enableVisAffix();
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
          // setTimeout(function() {
          //   $("#carousel").fadeIn("slow");
          // }, 100);
        // that.analyzeGroupView.sortRepness();
      });
      // that.analyzeGlobalView.showCarousel();
    });

    that.conversationTabs.on("beforeshow:vote", function() {
      moveVisToBottom();
      that.showVis();
      that.showTutorial();
    });
    that.conversationTabs.on("aftershow:analyze", function() {
      
      that.analyzeGlobalView.renderWithCarousel();

      if (SHOULD_AUTO_CLICK_FIRST_COMMENT) {
        $(".query_result_item").first().trigger("click");
      }
      if (display.xs()) {
        $("#tutorialSlides").hide();
      }
    });
    that.conversationTabs.on("aftershow:group", function() {
      $(".query_result_item").first().trigger("click");
    });
    that.conversationTabs.on("aftershow:write", function() {
      // Put the comment textarea in focus (should pop up the keyboard on mobile)
      $("#tutorialSlides").hide();
      $("#comment_form_textarea").focus();
    });

    window.playback = function() {
      $.get("/api/v3/math/pcaPlaybackList?conversation_id="+that.conversation_id).then(function(result) {
        if (!result) {
          alert("couldn't find playback data");
        }
        result.sort(function(a, b) {
          return a.lastVoteTimestamp - b.lastVoteTimestamp;
        });
        // var result = [
        //   {lastVoteTimestamp: 123, n: 5, "n-cmts": 100},
        //   {lastVoteTimestamp: 135, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 136, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 137, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 138, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 139, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 149, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 155, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 165, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 175, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 185, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 195, n: 6, "n-cmts": 102},
        //   {lastVoteTimestamp: 235, n: 6, "n-cmts": 102},
        //   ];
        $("#visualization_div > #playbackLinks").remove();
        $("#visualization_div").append("<div id='playbackLinks' style='max-height:100px; overflow:scroll;'></div>");
        _.each(result, function(r) {
          var label = [r.lastVoteTimestamp, r.n+" ptpts", r["n-cmts"]+" comments", (new Date(r.lastVoteTimestamp)).toLocaleTimeString()].join(", ");
          $("#playbackLinks").append(
            "<a class='playbacklink' id='"+ r.lastVoteTimestamp+"' data-foo='"+label+"'>" + r.n + " </a>");
        });

        $("#playbackLinks > .playbacklink").on("click", function(ev) {
          var timestamp = Number(ev.target.id);
          $("#playbackLinks > .playbacklink").css("background-color", "rgba(0,0,0,0)");
          $(ev.target).css("background-color", "orange");
          that.serverClient.jumpTo(timestamp);
        });
      });
    };

    function tutorialStart() {
      that.tutorialSlidesModel.set("step", 1);
      that.visModeModel.set("visMode", VIS_MODE_TUT);
      $("#commentViewTab").click();
    }

    this.listenTo(this, "render", function(){
      setTimeout(function() {

      if (false) {
        $("#voteMoreParent").show();
      }

      // if (launchWithTutorial) {
      //   $("#tutorialSlides").show();
      // }


      $("#resetVisBlockerTutorial").on("click", tutorialStart);
      

      that.updateVisMode();

      // that.visModeModel.set("visMode", VIS_MODE_WAITING);

      $("#getDataButton").on("click", function() {
        $.get("/api/v3/dummyButton?button=getDataButton");
        setTimeout(function() {
          alert("coming soon!");
        });
      });

      $("#closeConversationButton").on("click", function() {
        $.post("/api/v3/conversation/close", {conversation_id: that.conversation_id}).then(function() {
          alert("Conversation closed! Writing and voting are disabled.");
          document.location.reload();
        }, function(err) {
          alert("error closing conversation");
        });
      });

      $("#reopenConversationButton").on("click", function() {
        $.post("/api/v3/conversation/reopen", {conversation_id: that.conversation_id}).then(function() {
          alert("Conversation reopened! Writing and voting are enabled.");
          document.location.reload();
        }, function(err) {
          alert("error reopening conversation");
        });
      });


      $("#closeLegendButton").on("click", function() {
        that.conversationTabs.hideLegend();
      });
      $("#nextTutorialStepButton").on("click", function() {
        that.vis.tutorialNextClicked();
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

      // that.commentView.on("showComment", _.once(function() {   

      //   that.$commentViewPopover = that.$("#commentView").popover({
      //     title: "START HERE",
      //     content: "Read comments submitted by other participants and react using these buttons. <button type='button' id='commentViewPopoverButton' class='Btn Btn-primary' style='display: block; margin-top:10px'> Ok, got it </button>",
      //     html: true, //XSS risk, not important for now
      //     trigger: "manual",
      //     placement: "bottom"
      //   });

      //   setTimeout(function(){
      //     if (that.conversationTabs.onVoteTab()) {
      //       that.$commentViewPopover.popover("show");
      //       $("#commentViewPopoverButton").click(function(){
      //         that.$commentViewPopover.popover("destroy");
      //       });
      //     }
      //   },2000);
      // }));


      
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
