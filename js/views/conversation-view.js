define([
  "view",
  "templates/conversation-view",
  "views/vote-view",
  "views/comment-form",
  "views/change-votes",
  "views/metadataQuestionsFilterView", // analyze view
  "views/results-view", //results view
  "models/vote",
  "models/participant",
  "models/conversation",
  "models/comment",
  "models/user",
  "collections/comments",
  "collections/votes",
  "collections/metadataQuestions",
  "collections/results",
  "p",
  "util/polisStorage",
  "util/utils",
  "VisView",
  "controllers/tutorialController",
  "polis"
  ], function (
    View,
    template,
    CommentView,
    CommentFormView,
    ChangeVotesView,
    MetadataQuestionsFilterView,
    ResultsView,
    VoteModel,
    ParticipantModel,
    ConversationModel,
    CommentModel,
    UserModel,
    CommentsCollection,
    VotesCollection,
    MetadataQuestionsCollection,
    ResultsCollection,
    p,
    PolisStorage,
    Utils,
    VisView,
    TutorialController,
    ServerClient
    ) {
  return View.extend({
    name: "conversation-view",
    template: template,
    events: {
    // "click #commentViewTab": function(e) {
    //   e.preventDefault();
    //   $(e.target).tab("show");
    // },
    // "click #commentFormTab": function(e) {
    //   e.preventDefault();
    //   $(e.target).tab("show");
    // },
    // "click #analyzeTab": function(e) {
    //   e.preventDefault();
    //   $(e.target).tab("show");
    // }
  },
  onClusterTapped : function() {
      if (window.isMobile()) {
         window.scrollTo(0, $("#visualization_div").offset().top);
      }
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

  initialize: function() {
    var that = this;
    var vis;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");

    this.tutorialController = new TutorialController();
    var metadataCollection = new MetadataQuestionsCollection([], {
        zid: zid
    });


    var resultsCollection = new ResultsCollection();

    window.m = metadataCollection;

    // HTTP PATCH - model.save({patch: true})

    function onClusterTapped() {
        that.onClusterTapped();
    }

    function initPcaVis() {
        var w = $("#visualization_div").width();
        var h = w/2;
        $("#visualization_div").height(h);
        if (vis) {
            serverClient.removePersonUpdateListener(vis.upsertNode);
        }
        vis = new VisView({
            getPid: function() {
              if (!_.isId(pid)) {
//                alert("bad pid: " + pid);
              }
              return pid;
            },
            getCommentsForProjection: serverClient.getCommentsForProjection,
            getCommentsForSelection: serverClient.getCommentsForSelection,
            getReactionsToComment: serverClient.getReactionsToComment,
            getUserInfoByPid: serverClient.getUserInfoByPidSync,
            getTotalVotesByPidSync: serverClient.getTotalVotesByPidSync,
            w: w,
            h: h,
            computeXySpans: Utils.computeXySpans,
            el_queryResultSelector: ".query_results_div",
            el: "#visualization_div"
        });
        vis.addClusterTappedListener(onClusterTapped);
        serverClient.addPersonUpdateListener(vis.upsertNode);
        that.tutorialController.setHandler("blueDot", vis.dipsplayBlueDotHelpItem);
    }

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


    this.votesByMe = new VotesCollection();

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
      domain: /localhost/.test(document.domain) ? "localhost:5000" : "www.polis.io",
      basePath: "",
      logger: console
    });

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
            alert(err);
          });
      });



      this.changeVotes = new ChangeVotesView({
        serverClient: serverClient,
        zid: zid
      });

      this.commentView = new CommentView({
        serverClient: serverClient,
        votesByMe: this.votesByMe,
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

      // this.votesByMe.on("all", function(x) {
      //   console.log("votesByMe.all", x);
      // });
      this.votesByMe.on("change", function() {
        console.log("votesByMe.change");
        serverClient.updateMyProjection(that.votesByMe);
      });
      this.votesByMe.on("add", function() {
        console.log("votesByMe.add");
        serverClient.updateMyProjection(that.votesByMe);
      });
      this.commentForm.on("commentSubmitted", function() {
        // $("#commentViewTab").tab("show");
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

    this.listenTo(this, "rendered", function(){
      setTimeout(function() {

      scrollTopOnFirstShow();

      $("#visualization_div").affix({
        offset: {
          top: 150 //will be set dynamically
        }
      });
      that.$("#commentViewTab").tooltip({
        title: "Start here - read and react to comments submitted by others.",
        placement: "top",
        delay: { show: 300, hide: 200 },
        container: "body"

      });
      that.$("#commentFormTab").tooltip({
        title: "If your ideas aren't already represented, submit your own comments. Other participants will be able to react.",
        placement: "top",
        delay: { show: 300, hide: 200 },
        container: "body"

      });
      that.$("#analyzeTab").tooltip({
        title: "Filters! Click on the \"analyze\" tab to sort participants using metadata. For instance, maybe you only want to see female respondants under 40, or only managers in the NYC office, etc.",
        placement: "top",
        delay: { show: 300, hide: 200 },
        container: "body"

      });
      var $commentViewPopover = that.$("#commentView").popover({
        title: "START HERE",
        content: "Read comments submitted by other participants and react using these buttons. <button type='button' id='commentViewPopoverButton' class='btn btn-lg btn-primary' style='margin-top:20px'> Ok, got it! </button>",
        html: true, //XSS risk, not important for now
        trigger: "manual",
        placement: "bottom"
      });

      setTimeout(function(){
        $commentViewPopover.popover("show")
        $("#commentViewPopoverButton").click(function(){
          $commentViewPopover.popover("hide")
        })
      },1000)

      initPcaVis();

      $(window).resize(_.throttle(initPcaVis, 100));

  }, 0); // end listenTo "rendered"
  });

  } // end initialize
  });
});
