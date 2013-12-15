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
  "VisView",
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
    VisView,
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
  initialize: function() {
    var that = this;
    var vis;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");

    var metadataCollection = new MetadataQuestionsCollection([], {
        zid: zid
    });


    var resultsCollection = new ResultsCollection();

    window.m = metadataCollection;

    // HTTP PATCH - model.save({patch: true})


    function onClusterTapped() {
        that.onClusterTapped();
    }

    function initPcaVis(serverClient) {
        var w = $("#visualization_div").width();
        var h = w/2;
        $("#visualization_div").height(h);
        if (vis) {
            serverClient.removePersonUpdateListener(vis.upsertNode);
        }
        vis = new VisView({
            getPid: function() {
              if (!_.isId(pid)) {
                alert("bad pid: " + pid);
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
            el_queryResultSelector: "#query_results_div",
            el: "#visualization_div"
        });
        vis.addClusterTappedListener(onClusterTapped);
        serverClient.addPersonUpdateListener(vis.upsertNode);
    }

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


    var serverClient = that.serverClient = new ServerClient({
      zid: zid,
      zinvite: zinvite,
      tokenStore: PolisStorage.token,
      pid: pid,
      //commentsStore: PolisStorage.comments,
      //reactionsByMeStore: PolisStorage.reactionsByMe,
      utils: window.utils,
      protocol: /localhost/.test(document.domain) ? "http" : "https",
      domain: /localhost/.test(document.domain) ? "localhost:5000" : "www.polis.io",
      basePath: "",
      logger: console
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
        zid: zid
      });

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

      this.commentForm.on("commentSubmitted", function() {
        $("#commentViewTab").tab("show");
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

      that.$("#commentViewTab").tooltip({
        title: "Start here - read and react to comments submitted by others.",
        placement: "top",
        delay: { show: 300, hide: 200 }

      });
      that.$("#commentFormTab").tooltip({
        title: "If your ideas aren't already represented, submit your own comment. Other participants will be able to react.",
        placement: "top",
        delay: { show: 300, hide: 200 }

      });
      that.$("#analyzeTab").tooltip({
        title: "Filters! Click on the \"analyze\" tab to sort participants using metadata. For instance, maybe you only want to see female respondants under 40, or only managers in the NYC office, etc.",
        placement: "top",
        delay: { show: 300, hide: 200 }

      });
      that.$("#how_do_i_use").popover({
        title: "How do I use Polis?",
        content: "<ol> <li> Read & react to what others have said.</li><li> Write comments for others to react to.</li> <li> Watch the visualization change in real-time as you and others react.</li><li> Optionally, explore the visualization to learn more about what brought the groups together and what is differentiating them.</li>  <li> Hover over the menu items and buttons to learn about them (mobile: press and hold). </li>  </ol>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "bottom"
      });
      that.$("#feedback_and_suggestions").popover({
        title: "Feedback & Suggestions",
        content: "<p> During the beta period, you can email us directly with feedback, questions or requests.</p> <i class=\"icon-info-envelope\"></i> <a href=\"mailto:colinmegill@gmail.com?Subject=Polis%20feedback:%20inbox\" target=\"_blank\">info@polis.io </a>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "bottom"
      });
      that.$("#making_meaning_of_viz").popover({
        title: "How do I make meaning of the visualization?",
        content: "<ol><li> Each dot represents a person. The red dot represents you. You will see the dots move around the visualization as you and other participants vote. Hover over a dot to find out who it is.</li><li> Dots that are closer together voted similarly. Dots that are furter apart voted differently.</li><li> Shaded areas represent groups. Click on a shaded area to bring up comments that had the highest consensus amongst that group. Click on a comment to see patterns of agreement and disagreement for the selected comment across the whole conversation. </li> <li> Participants who agreed with a selected comment are represented as a green up arrow. Participants who disagreed are represented as a red down arrow. Participants who haven't reacted to the selected comment remain a grey dot. </li> <li> Use the \"analyze\" tab to filter participants using metadata.</li></ol>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "top"
      });

      initPcaVis(serverClient);

      $(window).resize(initPcaVis);

  }); // end listenTo "rendered"
  }, 0);

  } // end initialize
  });
});
