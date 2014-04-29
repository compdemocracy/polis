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


module.exports = Handlebones.ModelView.extend({

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


  allowMetadataFiltering: function() {
    return true;
  },

  emphasizeParticipants: function() {
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

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");

    this.tutorialController = new TutorialController();

    this.votesByMe = new VotesCollection();
    this.allCommentsCollection = new CommentsCollection();
    this.allCommentsCollection.firstFetchPromise = $.Deferred();


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
      comments: this.allCommentsCollection,
      //commentsStore: PolisStorage.comments,
      //reactionsByMeStore: PolisStorage.reactionsByMe,
      utils: window.utils,
      protocol: /localhost/.test(document.domain) ? "http" : "https",
      domain: /localhost/.test(document.domain) ? "localhost:5000" : "pol.is",
      basePath: "",
      logger: console
    });

    this.updateVotesByMeCollection();
    this.serverClient.addPollingScheduledCallback(function() {
      that.updateVotesByMeCollection();
    });
    this.serverClient.startPolling();


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


  }
});