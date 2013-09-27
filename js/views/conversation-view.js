define([
  'view',
  'templates/conversation-view',
  'views/comment-view',
  'views/comment-form',
  'views/change-votes',
  'models/vote',
  'models/participant',
  'models/conversation',
  'models/comment',
  'models/user',
  'collections/comments',
  'collections/votes',
  'app',
  'CommentShower',
  'FeedbackSubmitter',
  'LoginView',
  'p',
  'polisUtils',
  'util/polisStorage',
  'polis',
  'VisView'
  ], function (View, 
    template,
    CommentView, 
    CommentFormView,
    ChangeVotesView,
    VoteModel,
    ParticipantModel,
    ConversationModel,
    CommentModel,
    UserModel,
    CommentsCollection,
    VotesCollection,
    app, 
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
    "click #topic_toggle": function(e){
      e.preventDefault();
      this.$('#topic').toggle();
    },
    "click #react_tab": function(e){
      e.preventDefault();
      console.dir(this);
      console.dir(e);
      $(e.target).tab('show');
    },
    "click #write_tab": function(e){
      e.preventDefault();
      //$(this).tab('show')
      $(e.target).tab('show');
    }
  },
  onClusterTapped : function() {
      if (window.isMobile()) {
         window.scrollTo(0,$("#visualization_div").offset().top);
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

    serverClient.observeStimulus(this.model.get('zid'));
    
    this.commentView = new CommentView({
      serverClient: serverClient,
      zid: this.zid,
    });

    // this.commentsByMe = new SomeViewColinWillCreate({
    //   serverClient: serverClient,
    //   zid: this.zid,
    // });

    this.commentForm = new CommentFormView({
      serverClient: serverClient,
      zid: this.zid,
    });
   
    this.changeVotes = new ChangeVotesView({
      serverClient: serverClient,
      zid: this.zid,
    })

    this.commentForm.on("commentSubmitted", function() {
      $("#react_tab").tab('show');
    });


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
            onClusterTapped: onClusterTapped,
            w: w,
            h: h,
            el_queryResultSelector: "#query_results_div",
            el: "#visualization_div"
        });
        serverClient.addPersonUpdateListener(vis.upsertNode);
    };


     // Let the DOM finish its layout
     _.defer(initPcaVis);
     $(window).resize(initPcaVis);
  }// end initialize
  });
});