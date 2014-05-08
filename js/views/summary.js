var CommentsCollection = require("../collections/comments");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var MetadataQuestionsCollection = require("../collections/metadataQuestions");
var MetadataQuestionsFilterView = require("../views/metadataQuestionsFilterView");
var PolisStorage = require("../util/polisStorage");
var popoverEach = require("../util/popoverEach");
var ServerClient = require("../lib/polis");
var TutorialController = require("../controllers/tutorialController");
var VotesCollection = require("../collections/votes");

var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var eb = require("../eventBus");
var template = require('../tmpl/summary');
var ConversationStatsHeader = require('../views/conversation-stats-header');


var display = require("../util/display");
var ResultsView = require("../views/results-view");
var VoteModel = require("../models/vote");
var ParticipantModel = require("../models/participant");
var CommentModel = require("../models/comment");
var UserModel = require("../models/user");
var CommentsCollection = require("../collections/comments");
var ResultsCollection = require("../collections/results");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");


var VIS_SELECTOR = "#visualization_div";

var isIE8 = navigator.userAgent.match(/MSIE [89]/);

module.exports =  Handlebones.ModelView.extend({
  name: "summaryView",
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
  hideVis: function() {
    $("#visualization_div").hide();
  },
  showVis: function() {
    $("#visualization_div").show();
  },
  allowMetadataFiltering: function() {
    return true;
  },

  emphasizeParticipants: function() {
    if (this.vis) {
      this.vis.emphasizeParticipants.apply(this, arguments);
    }
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");
    var vis;

    this.tutorialController = new TutorialController();

    this.votesByMe = new VotesCollection();

    this.commentsCollection0 = new CommentsCollection();
    this.commentsCollection1 = new CommentsCollection();
    this.commentsCollection2 = new CommentsCollection();
    this.commentsCollection0.firstFetchPromise = $.Deferred();
    this.commentsCollection1.firstFetchPromise = $.Deferred();
    this.commentsCollection2.firstFetchPromise = $.Deferred();


    var metadataCollection = new MetadataQuestionsCollection([], {
        zid: zid
    });

    metadataCollection.fetch({
      data: $.param({
        zid: zid
      }),
      processData: true
    });


    var serverClient = that.serverClient = new ServerClient({
      zid: zid,
      zinvite: zinvite,
      tokenStore: PolisStorage.token,
      pid: pid,
      votesByMe: this.votesByMe,
      //commentsStore: PolisStorage.comments,
      //reactionsByMeStore: PolisStorage.reactionsByMe,
      utils: window.utils,
      protocol: /localhost/.test(document.domain) ? "http" : "https",
      domain: /localhost/.test(document.domain) ? "localhost:5000" : "pol.is",
      basePath: "",
      logger: console
    });

    this.serverClient.startPolling();


    function updateRepness(tidToRepness) {
      this.each(function(model) {
        model.set("repness", tidToRepness[model.get("tid")], {silent: true});
      });
    }
    this.commentsCollection0.updateRepness = updateRepness;
    this.commentsCollection1.updateRepness = updateRepness;
    this.commentsCollection2.updateRepness = updateRepness;

    function doFetch() {
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
    }

    this.commentsCollection0.fetch = this.commentsCollection0.doFetch = doFetch;
    this.commentsCollection1.fetch = this.commentsCollection1.doFetch = doFetch;
    this.commentsCollection2.fetch = this.commentsCollection2.doFetch = doFetch;



       // CHILD VIEWS

      this.metadataQuestionsView = this.addChild(new MetadataQuestionsFilterView({
        serverClient: serverClient,
        zid: zid,
        collection: metadataCollection
      }));

       // LISTEN TO EVENTS

      this.listenTo(this.metadataQuestionsView, "answersSelected", function(enabledAnswers) {
        if (that.allowMetadataFiltering()) {
          console.log(enabledAnswers);
          serverClient.queryParticipantsByMetadata(enabledAnswers).then(
            that.emphasizeParticipants.bind(that),
            function(err) {
              console.error(err);
            });
        }
      });

      // Clicking on the background dismisses the popovers.
      this.$el.on("click", function() {
        that.destroyPopovers();
      });




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
      vis = that.vis = new VisView({
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


      /* child views */

      this.commentsByMe = new CommentsCollection({
        zid: zid,
        pid: pid
      });

      this.resultsView = this.addChild(new ResultsView({
        serverClient: serverClient,
        zid: zid,
        collection: resultsCollection
      }));


      this.analyzeGlobalView0 = this.addChild(new AnalyzeGlobalView({
        zid: zid,
        isIE8: isIE8,
        gid: 0,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup(0, 5);          
        },
        collection: this.commentsCollection0
      }));
      this.analyzeGlobalView1 = this.addChild(new AnalyzeGlobalView({
        zid: zid,
        isIE8: isIE8,
        gid: 1,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup(1, 5);          
        },
        collection: this.commentsCollection1
      }));
      this.analyzeGlobalView2 = this.addChild(new AnalyzeGlobalView({
        zid: zid,
        isIE8: isIE8,
        gid: 2,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup(2, 5);          
        },
        collection: this.commentsCollection2
      }));            

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

    // Clicking on the background dismisses the popovers.
    this.$el.on("click", function() {
      that.destroyPopovers();
    });

    eb.on(eb.clusterClicked, this.onClusterTapped.bind(this));
    eb.on(eb.queryResultsRendered, this.onAnalyzeTabPopulated.bind(this));



    this.listenTo(this, "render", function(){
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



      setTimeout(function() {
        that.commentsCollection0.doFetch().then(function() {
          // that.analyzeGlobalView0.sortAgree();              
        });
        that.commentsCollection1.doFetch().then(function() {
          // that.analyzeGlobalView1.sortAgree();              
        });
        that.commentsCollection2.doFetch().then(function() {
          // that.analyzeGlobalView2.sortAgree();              
        });
      }, 5000);
      

  }, 0); // end listenTo "render"
  });
  this.render();
  } // end initialize
});