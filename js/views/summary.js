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
var VoteModel = require("../models/vote");
var VotesCollection = require("../collections/votes");

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
  },  
  onAnalyzeTabPopulated: function() {
    $('.query_result_item').first().trigger('click');
  },
  allowMetadataFiltering: function() {
    return true;
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var sid = this.sid = this.model.get("sid");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");

    function doFetch(o) {
      var thatCollection = this;
      var params = {
        gid: o.gid,
        sid: sid
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
          sid: sid,
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
        sid: sid
    });

    metadataCollection.fetch({
      data: $.param({
        sid: sid
      }),
      processData: true
    });

    var serverClient = that.serverClient = new ServerClient({
      sid: sid,
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
        sid: sid,
        collection: metadataCollection
      }));

       // LISTEN TO EVENTS

      this.listenTo(this.metadataQuestionsView, "answersSelected", function(enabledAnswers) {
        if (that.allowMetadataFiltering()) {
          console.log(enabledAnswers);
          serverClient.queryParticipantsByMetadata(enabledAnswers).then(
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

    }


    function configureGutters() {     
      if (display.xs()) {
        $("#controlTabs").addClass("no-gutter");
      } else {
        $("#controlTabs").removeClass("no-gutter");        
      }
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
        sid: sid,
        pid: pid
      });

      this.resultsView = this.addChild(new ResultsView({
        serverClient: serverClient,
        sid: sid,
        collection: resultsCollection
      }));

      eb.on(eb.commentSelected, function(tid) {
 
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
 
      configureGutters();




  }, 0); // end listenTo "render"
  });
  this.render();
  } // end initialize
});