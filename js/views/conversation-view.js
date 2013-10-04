define([
  'view',
  'templates/conversation-view',
  'views/comment-view',
  'views/comment-form',
  'views/change-votes',
  'views/analyze',
  'models/vote',
  'models/participant',
  'models/conversation',
  'models/comment',
  'models/user',
  'collections/comments',
  'collections/votes',
  'collections/metadata',
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
    AnalyzeView,
    VoteModel,
    ParticipantModel,
    ConversationModel,
    CommentModel,
    UserModel,
    CommentsCollection,
    VotesCollection,
    MetadataCollection,
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

    serverClient.observeStimulus(this.model.get('zid'), this.model.get('zinvite'));
    
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
   
    var metadataCollection = new MetadataCollection();







// ***************************************
// ***************************************
    metadataCollection.create({
      'question': 'Do you like sunrises and puppies?',
      'answers': ['biodiesel',
                  'Williamsburg',
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur tempor consequat. Shabby chic mollit laborum consectetur ethnic umami kale chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt f chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur te Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.'],
      required: true
    })
    metadataCollection.create({
      'question': 'Do you like sunrises and puppies?',
      'answers': ['biodiesel',
                  'Williamsburg',
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur tempor consequat. Shabby chic mollit laborum consectetur ethnic umami kale chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt f chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur te Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.'],
      required: true
    })
    metadataCollection.create({
      'question': 'Do you like sunrises and puppies?',
      'answers': ['biodiesel',
                  'Williamsburg',
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur tempor consequat. Shabby chic mollit laborum consectetur ethnic umami kale chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt f chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur te Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.'],
      required: true
    })
    metadataCollection.create({
      'question': 'Do you like sunrises and puppies?',
      'answers': ['biodiesel',
                  'Williamsburg',
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur tempor consequat. Shabby chic mollit laborum consectetur ethnic umami kale chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt f chips eiusmod Schlitz cray, velit photo booth meh street art. Vegan yr raw denim, chia chillwave lo-fi viral Bushwick butcher American Apparel cornhole. Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.', 
                  'Sunt biodiesel authentic, Williamsburg Schlitz elit disrupt fanny pack nulla synth culpa excepteur te Roof party letterpress blog, culpa semiotics literally wayfarers. Veniam cliche excepteur, culpa ethical Brooklyn actually assumendkogi drinking vinegar.'],
      required: true
    })

// ***************************************
// ***************************************

    this.analyzeView = new AnalyzeView({
      serverClient: serverClient,
      zid: this.zid,
      collection: metadataCollection
    })

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
            getUserInfoByPid: serverClient.getUserInfoByPid,
            w: w,
            h: h,
            el_queryResultSelector: "#query_results_div",
            el: "#visualization_div"
        });
        vis.addClusterTappedListener(onClusterTapped);
        serverClient.addPersonUpdateListener(vis.upsertNode);
    };


     // Let the DOM finish its layout
     _.defer(initPcaVis);
     $(window).resize(initPcaVis);
  }// end initialize
  });
});
