var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var eb = require("../eventBus");
var View = require('../view');
var template = require('../tmpl/conversation-view');
var CommentView = require('../views/vote-view');
var CommentFormView = require("../views/comment-form")
var ChangeVotesView = require("../views/change-votes");
var display = require("../util/display");
var MetadataQuestionsFilterView = require("../views/metadataQuestionsFilterView");
var ResultsView = require("../views/results-view");
var VoteModel = require("../models/vote");
var ParticipantModel = require("../models/participant");
var ConversationModel = require("../models/conversation");
var CommentModel = require("../models/comment");
var UserModel = require("../models/user");
var CommentsCollection = require("../collections/comments");
var VotesCollection = require("../collections/votes");
var MetadataQuestionsCollection = require("../collections/metadataQuestions");
var ResultsCollection = require("../collections/results");
var PolisStorage = require("../util/polisStorage");
var popoverEach = require("../util/popoverEach");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");
var TutorialController = require("../controllers/tutorialController");
var ServerClient = require("../lib/polis");

var VIS_SELECTOR = "#visualization_div";
var ANALYZE_TAB = "analyzeTab";
var WRITE_TAB = "commentFormTab";
var VOTE_TAB = "commentViewTab";

var isIE8 = navigator.userAgent.match(/MSIE 8/);

function shouldShowVisUnderTabs() {
  return display.xs();
}
function shouldHideVisWhenWriteTabShowing() {
  return shouldShowVisUnderTabs();
}


module.exports =  View.extend({
  name: "conversation-view",
  template: template,
  events: {
  },
  destroyPopovers: function() {
    popoverEach("destroy");
  },
  onClusterTapped : function(gid) {
    this.destroyPopovers();
    var that = this;
      // if (window.isMobile()) {
      //    window.scrollTo(0, $("#visualization_div").offset().top);
      // }
  },
  onAnalyzeTabPopulated: function() {
    $('.query_result_item').first().trigger('click');
  },
  updateVotesByMeCollection: function() {
    console.log("votesByMe.fetch");
    if (this.pid < 0) {
      // DEMO_MODE
      return;
    }
    this.votesByMe.fetch({
      data: $.param({
        zid: this.zid,
        pid: this.pid
      }),
      reset: false
    });
  },
  hideVis: function() {
    $("#visualization_div").hide();
  },
  showVis: function() {
    $("#visualization_div").show();
  },

  initialize: function() {
    var that = this;
    var vis;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");

    this.tutorialController = new TutorialController();
    var metadataCollection = new MetadataQuestionsCollection([], {
        zid: zid
    });


    var resultsCollection = new ResultsCollection();

    // HTTP PATCH - model.save({patch: true})

    function onClusterTapped() {
        that.onClusterTapped();
    }

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

      $(VIS_SELECTOR).html("").height(0);
      // $(VIS_SELECTOR).parent().css("display", "none");



      var w = $(VIS_SELECTOR).width();
      if (isIE8) {
        w = 500;
        $(VIS_SELECTOR).width(w);
      }
      var h = w/2;
      $(VIS_SELECTOR).height(h);
      that.serverClient.removePersonUpdateListener(onPersonUpdate);
      vis = new VisView({
          getPid: function() {
            if (!_.isId(pid)) {
              //alert("bad pid: " + pid);
            }
            return pid;
          },
          isIE8: isIE8,
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

      that.serverClient.addPersonUpdateListener(onPersonUpdate)

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
    }  

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


    this.votesByMe = new VotesCollection();

    this.allCommentsCollection = new CommentsCollection();
    this.allCommentsCollection.firstFetchPromise = $.Deferred();

    var serverClient = that.serverClient = new ServerClient({
      zid: zid,
      zinvite: zinvite,
      tokenStore: PolisStorage.token,
      pid: pid,
      votesByMe: this.votesByMe,
      comments: this.allCommentsCollection,
      //commentsStore: PolisStorage.comments,
      //reactionsByMeStore: PolisStorage.reactionsByMe,
      utils: window.utils,
      protocol: /localhost/.test(document.domain) ? "http" : "https",
      domain: /localhost/.test(document.domain) ? "localhost:5000" : "pol.is",
      basePath: "",
      logger: console
    });

    this.allCommentsCollection.updateRepness = function(tidToRepness) {
      this.each(function(model) {
        model.set("repness", tidToRepness[model.get("tid")], {silent: true});
      });
    };

    this.allCommentsCollection.fetch = this.allCommentsCollection.doFetch = function() {
      var thatCollection = this;
      var params = {
        zid: zid
      };
      var promise = Backbone.Collection.prototype.fetch.call(this, {
        data: $.param(params),
        processData: true,
        silent: true,
        ajax: function() {
          return that.serverClient.getFancyComments(params);
        }
      });
      promise.then(this.firstFetchPromise.resolve);
      promise.then(function() {
        thatCollection.trigger("reset");
      });
      return promise;
    };

      this.serverClient.addPollingScheduledCallback(function() {
        that.updateVotesByMeCollection();
      });
      this.serverClient.startPolling();
      /* child views */

      this.metadataQuestionsView = new MetadataQuestionsFilterView({
        serverClient: serverClient,
        zid: zid,
        collection: metadataCollection
      });

      this.listenTo(this.metadataQuestionsView, "answersSelected", function(enabledAnswers) {
        console.log(enabledAnswers);
        serverClient.queryParticipantsByMetadata(enabledAnswers).then(
          vis.emphasizeParticipants,
          function(err) {
            console.error(err);
          });
      });



      this.changeVotes = new ChangeVotesView({
        serverClient: serverClient,
        zid: zid
      });

      this.commentView = new CommentView({
        serverClient: serverClient,
        votesByMe: this.votesByMe,
        is_public: is_public,
        pid: pid,
        zid: zid
      });
      // this.commentView.on("vote", this.tutorialController.onVote);

      this.commentsByMe = new CommentsCollection({
        zid: zid,
        pid: pid
      });

      this.commentForm = new CommentFormView({
        pid: pid,
        collection: this.commentsByMe,
        zid: zid
      });

      this.resultsView = new ResultsView({
        serverClient: serverClient,
        zid: zid,
        collection: resultsCollection
      });


      this.analyzeGlobalView = new AnalyzeGlobalView({
        zid: zid,
        isIE8: isIE8,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      });

      eb.on(eb.commentSelected, function(tid) {
        vis.selectComment(tid);
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

      /* tooltips */
      console.log("here are the views children:");
      console.dir(this.children);

      metadataCollection.fetch({
          data: $.param({
              zid: zid
          }),
          processData: true
      });
      this.commentForm.updateCollection();

    // Clicking on the background dismisses the popovers.
    this.$el.on("click", function() {
      that.destroyPopovers();
    });

    eb.on("clusterClicked", onClusterTapped);
    eb.on("queryResultsRendered", _.bind(this.onAnalyzeTabPopulated, this));

    this.listenTo(this, "rendered", function(){
      setTimeout(function() {

      scrollTopOnFirstShow();

      // $("#visualization_div").affix({
      //   offset: {
      //     top: 150 //will be set dynamically
      //   }
      // });
      function deselectHulls() {
        if (vis) {
          vis.deselect();
        }
      }
      // Before shown
      $('a[data-toggle="tab"]').on('show.bs.tab', function (e) {
        var to = e.target;
        var from = e.relatedTarget;
        if (to && to.id === WRITE_TAB && shouldHideVisWhenWriteTabShowing()) {
          // When we're switching to the write tab, hide the vis.
          that.hideVis();
        }
         // previous tab
        if (from && from.id === WRITE_TAB) {
          // When we're leaving the write tab, show the vis again.
          that.showVis();
        }
        if(from && from.id === ANALYZE_TAB) {
          // that.analyzeGlobalView.hideCarousel();
          that.analyzeGlobalView.deselectComments();
        }
        if(to && to.id === ANALYZE_TAB) {
          if (shouldShowVisUnderTabs()) {
            moveVisAboveQueryResults();
          }

          that.allCommentsCollection.doFetch().then(function() {
            that.analyzeGlobalView.sortAgree();
          });
          // that.analyzeGlobalView.showCarousel();
        }
        if(to && to.id === VOTE_TAB) {
          if (shouldShowVisUnderTabs()) {
            moveVisToBottom();
          }
        }
      });

      // After shown
      $('a[data-toggle="tab"]').on('shown.bs.tab', function (e) {
        console.log(e.target);
        // e.relatedTarget // previous tab
        if(e.target && e.target.id === ANALYZE_TAB) {
          $(".query_result_item").first().trigger("click");
        }
      });


      that.commentView.on("showComment", _.once(function() {
        that.$("#"+VOTE_TAB).tooltip({
          title: "Start here - read and react to comments submitted by others.",
          placement: "top",
          delay: { show: 300, hide: 200 },
          container: "body"

        })
        .on("click", deselectHulls);
      }));

      that.$("#" + WRITE_TAB).tooltip({
        title: "If your ideas aren't already represented, submit your own comments. Other participants will be able to react.",
        placement: "top",
        delay: { show: 300, hide: 200 },
        container: "body"
      })
      .on("click", deselectHulls);

      that.$("#"+ANALYZE_TAB).tooltip({
        title: "Filters! Click on the \"analyze\" tab to sort participants using metadata. For instance, maybe you only want to see female respondants under 40, or only managers in the NYC office, etc.",
        placement: "top",
        delay: { show: 300, hide: 200 },
        container: "body"

      // Wait until the first comment is shown before showing the tooltip
      });
      that.commentView.on("showComment", _.once(function() {   

        that.$commentViewPopover = that.$("#commentView").popover({
          title: "START HERE",
          content: "Read comments submitted by other participants and react using these buttons. <button type='button' id='commentViewPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true, //XSS risk, not important for now
          trigger: "manual",
          placement: "bottom"
        });

        setTimeout(function(){
          that.$commentViewPopover.popover("show");
          $("#commentViewPopoverButton").click(function(){
            that.$commentViewPopover.popover("destroy");
          });
        },1000);
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




  }, 0); // end listenTo "rendered"
  });

  } // end initialize
});