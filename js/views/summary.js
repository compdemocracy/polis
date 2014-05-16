var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var CommentModel = require("../models/comment");
var CommentsCollection = require("../collections/comments");
var display = require("../util/display");
var eb = require("../eventBus");
var GroupSummaryTemplate = require("../tmpl/group-summary");
var Handlebones = require("handlebones");
var MetadataQuestionsCollection = require("../collections/metadataQuestions");
var MetadataQuestionsFilterView = require("../views/metadataQuestionsFilterView");
var ParticipantModel = require("../models/participant");
var PolisStorage = require("../util/polisStorage");
var popoverEach = require("../util/popoverEach");
var ResultsCollection = require("../collections/results");
var ResultsView = require("../views/results-view");
var ServerClient = require("../lib/polis");
var template = require('../tmpl/summary');
var TutorialController = require("../controllers/tutorialController");
var UserModel = require("../models/user");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");
var VoteModel = require("../models/vote");
var VotesCollection = require("../collections/votes");

var VIS_SELECTOR = "#visualization_div";

var isIE8 = navigator.userAgent.match(/MSIE [89]/);


function updateRepness(tidToRepness) {
  this.each(function(model) {
    model.set("repness", tidToRepness[model.get("tid")], {silent: true});
  });
}

    
var groupNames = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

module.exports =  Handlebones.ModelView.extend({
  name: "summaryView",
  template: template,
  events: {
  },


  groupInfo: function(gid) {
    return this.serverClient.getGroupInfo(gid);
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

    function doFetch(o) {
      var thatCollection = this;
      var params = {
        gid: o.gid,
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



    var SummaryItemView = Handlebones.ModelView.extend({
      template: GroupSummaryTemplate,
      groupInfo: function() {
        return this.parent.groupInfo(this.model.get("gid"));
      },
      initialize: function(options) {
        Handlebones.ModelView.prototype.initialize.apply(this, arguments);

        this.commentsCollection = new CommentsCollection();
        this.commentsCollection.firstFetchPromise = $.Deferred();
        this.commentsCollection.updateRepness = updateRepness;
        this.commentsCollection.fetch = this.commentsCollection.doFetch = doFetch;

        var gid = this.model.get("gid");

        this.commentsCollection.fetch({
          gid: gid
        }).then(function() {
          // that.analyzeGlobalView0.sortAgree();              
        });


        this.analyzeGlobalView = this.addChild(new AnalyzeGlobalView({
          zid: zid,
          isIE8: isIE8,
          gid: gid,
          getTidsForGroup: function() {
            return that.serverClient.getTidsForGroup(gid, 5);          
          },
          collection: this.commentsCollection
        }));       

      }
    });


    var SummaryItemCollectionView = Handlebones.CollectionView.extend({
      modelView: SummaryItemView,
      groupInfo: function(gid) {
        return this.parent.groupInfo(gid);
      },
    });


    this.groupCollection =  new Backbone.Collection([
        // {
        //   gid:0
        // },{
        //   gid:1
        // },{
        //   gid:2
        // }
        ]);

    this.summaryItemCollectionView = this.addChild(new SummaryItemCollectionView({
      collection: this.groupCollection
     
    }));

    this.tutorialController = new TutorialController();

    this.votesByMe = new VotesCollection();

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

    this.serverClient.addPersonUpdateListener(function(buckets, clusters) {
      var bidToCount = {};
      _.each(buckets, function(b) {
        bidToCount[b.bid] = b.count;
      });
      var totalParticipants = 0;
      var i = 0;
      clusters = _.map(clusters, function(bids) {
        var o = {};
        var count = _.reduce(
          _.map(bids, function(bid) {return bidToCount[bid];}),
          function(a,b ) { return a+b;}, 0);
        o.participantCount = count;
        totalParticipants += count;
        o.gid = i++;
        o.name = groupNames[o.gid];
        return o;
      });
      _.each(clusters, function(cluster) {
        cluster.percent = Math.floor(cluster.participantCount / totalParticipants * 100);
      });
      that.groupCollection.set(clusters);
    });


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



      $('#fileSelected').click(function(){
        var reader = new FileReader();
        reader.readAsText($('#fileinput').get(0).files[0]);
        reader.onload = function (e) {
          // console.log(d3.csv.parse(e.target.result));
          serverClient.parseMetadataFromCSV(e.target.result);
        }
      });



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



  }, 0); // end listenTo "render"
  });
  this.render();
  } // end initialize
});