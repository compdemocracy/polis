define([
  'view',
  'templates/conversation-view',
  'views/comment-view',
  'views/comment-form',
  'views/change-votes',
  'views/metadataQuestionsView', // analyze view
  'views/results-view', //results view
  'models/vote',
  'models/participant',
  'models/conversation',
  'models/comment',
  'models/user',
  'collections/comments',
  'collections/votes',
  'collections/metadataQuestions',
  'collections/results',
  'CommentShower',
  'FeedbackSubmitter',
  'LoginView',
  'p',
  'polisUtils',
  'util/polisStorage',
  'polis',
  'VisView'
  ], function (
    View, 
    template,
    CommentView, 
    CommentFormView,
    ChangeVotesView,
    MetadataQuestionsView,
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
    CommentShower, 
    FeedbackSubmitter,
    LoginView,
    p,
    polisUtils,
    PolisStorage,
    ServerClient,
    VisView
    ) {
  return View.extend({
    name: 'conversation-view',
    template: template,
    events: {
    "click #topic_toggle": function(e) {
      e.preventDefault();
      this.$('#topic').toggle();
    },
    "click #react_tab": function(e) {
      e.preventDefault();
      console.dir(this);
      console.dir(e);
      $(e.target).tab('show');
    },
    "click #write_tab": function(e) {
      e.preventDefault();
      //$(this).tab('show')
      $(e.target).tab('show');
    },
    "click .query_result_item": function(e){
      this.$('.query_result_item').removeClass('active_result_item');
      this.$(e.target).addClass('active_result_item');
    },
  },
  onClusterTapped : function() {
      if (window.isMobile()) {
         window.scrollTo(0, $("#visualization_div").offset().top);
      }
  },
  initialize: function(){
    var that = this;
    var vis;
    var serverClient = new ServerClient({
      tokenStore: PolisStorage.token,
      emailStore: PolisStorage.email,
      usernameStore: PolisStorage.username,
      pidStore: PolisStorage.pids,
      uidStore: PolisStorage.uid,
      //commentsStore: PolisStorage.comments,
      //reactionsByMeStore: PolisStorage.reactionsByMe,
      utils: window.utils,
      protocol: "", //"http",
      domain: (-1 !== document.domain.indexOf(".polis.io")) ? "api.polis.io" : "localhost:5000",
      basePath: "",
      logger: console
    });

    serverClient.observeStimulus(this.model.get('zid'), this.model.get('zinvite'));
    // this.commentsByMe = new SomeViewColinWillCreate({
    //   serverClient: serverClient,
    //   zid: this.zid,
    // });
    var metadataCollection = new MetadataQuestionsCollection([], {
        zid: this.zid,
    });

    metadataCollection.fetch({
        data: $.param({
            zid: this.zid
        }), 
        processData: true,
    });

    var resultsCollection = new ResultsCollection()

    window.m = metadataCollection;

    // HTTP PATCH - model.save({patch: true})

    /* child views */

    this.metadataQuestionsView = new MetadataQuestionsView({
      serverClient: serverClient,
      zid: this.zid,
      collection: metadataCollection,
    });

    this.changeVotes = new ChangeVotesView({
      serverClient: serverClient,
      zid: this.zid,
    });

    this.commentView = new CommentView({
      serverClient: serverClient,
      zid: this.zid,
    });

    this.commentForm = new CommentFormView({
      serverClient: serverClient,
      zid: this.zid,
    });

    this.resultsView = new ResultsView({
      serverClient: serverClient,
      zid: this.zid,
      collection: resultsCollection
    })


    this.commentForm.on("commentSubmitted", function() {
      $("#react_tab").tab('show');
    });

    /* tooltips */
    console.log('here are the views children:')
    console.dir(this.children)




    function onClusterTapped() {
        that.onClusterTapped();
    }

    var initPcaVis = function() {
        var w = $("#visualization_div").width();
        var h = w/2;
        $("#visualization_div").height(h);
        if (vis) {
            serverClient.removePersonUpdateListener(vis.upsertNode);
        }
        vis = PcaVis({
            getPersonId: function() {
                return PolisStorage.pids.get(that.zid);
            },
            getCommentsForProjection: serverClient.getCommentsForProjection,
            getCommentsForSelection: serverClient.getCommentsForSelection,
            getReactionsToComment: serverClient.getReactionsToComment,
            getUserInfoByPid: serverClient.getUserInfoByPid,
            w: w,
            h: h,
            el_queryResultSelector: "#query_results_div",
            el: "#visualization_div"
        });
        vis.addClusterTappedListener(onClusterTapped);
        serverClient.addPersonUpdateListener(vis.upsertNode);
    };


    this.listenTo(this, 'rendered', function(){
      this.$('#commentViewTab').tooltip({
        title: "Start here - read and react to comments submitted by others.",
        placement: "top"
      });
      this.$('#commentFormTab').tooltip({
        title: "If your ideas aren't already represented, submit your own comment. Other participants will be able to react.",
        placement: "top"
      });
      this.$('#analyzeTab').tooltip({
        title: "Filters! Click on the 'analyze' tab to sort participants using metadata. For instance, maybe you only want to see female respondants under 40, or only managers in the NYC office, etc.",
        placement: "top"
      }); 
      this.$('#how_do_i_use').popover({
        title: "How do I use Polis?",
        content: "<ol> <li> Read & react to what others have said.</li><li> Write comments for others to react to.</li> <li> Watch the visualization change in real-time as you and others react.</li><li> Optionally, explore the visualization to learn more about what brought the groups together and what is differentiating them.</li>  <li> Hover over the menu items and buttons to learn about them (mobile: press and hold). </li>  </ol>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "bottom",
      });
      this.$('#feedback_and_suggestions').popover({
        title: "Feedback & Suggestions",
        content: "<p> During the beta period, you can email us directly with feedback, questions or requests.</p> <i class=\"icon-info-envelope\"></i> <a href=\"mailto:info@polis.io?Subject=Polis%20feedback:%20inbox\" target=\"_blank\">info@polis.io </a>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "bottom",
      });
      this.$('#making_meaning_of_viz').popover({
        title: "How do I make meaning of the visualization?",
        content: "<ol><li> Each dot represents a person. The red dot represents you. You will see the dots move around the visualization as you and other participants vote. Hover over a dot to find out who it is.</li><li> Dots that are closer together voted similarly. Dots that are furter apart voted differently.</li><li> Shaded areas represent groups. Click on a shaded area to bring up comments that had the highest consensus amongst that group. Click on a comment to see patterns of agreement and disagreement for the selected comment across the whole conversation. </li> <li> Participants who agreed with a selected comment are represented as a green up arrow. Participants who disagreed are represented as a red down arrow. Participants who haven't reacted to the selected comment remain a grey dot. </li> <li> Use the 'analyze' tab to filter participants using metadata.</li></ol>",
        html: true, //XSS risk, not important for now
        trigger: "click",
        placement: "top",
      });
    })

     // Let the DOM finish its layout
     _.defer(initPcaVis);
     $(window).resize(initPcaVis);
  }// end initialize
  });
});
