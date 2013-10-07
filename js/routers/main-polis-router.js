define([  //begin dependencies
  'views/root',
  'backbone',
  'models/conversation',
  'collections/conversations',
  'views/inbox',
  'views/homepage',
  'views/create-conversation-form',
  'views/conversation-details',
  'views/conversation-view',
  'views/create-user-form',
  'views/login-form',
  'views/landing-page',
  'util/polisStorage',
  'jquery',
], function (  //begin args
		RootView, 
		Backbone, 
		ConversationModel,
		ConversationsCollection, 
		InboxView, 
		HomepageView, 
		CreateConversationFormView,
		ConversationDetailsView,
		ConversationView,
		CreateUserFormView,
    LoginFormView,
    LandingPageView,
    PolisStorage,
    $
	) {  //end args, begin function block
	return Backbone.Router.extend({
    routes: {
      "homepage": "homepageView",
      "conversation/create": "createConversation",
      "conversation/edit/:id": "editConversation",
      "conversation/details/:id": "conversationDetails",
      "conversation/view/:id(/:zinvite)": "conversationView", 
      "user/create": "createUser",
      "user/login":"login",
      "inbox(/:filter)": "inbox",
      "": "landingPageView",
      // see others in the initialize method
    },
    initialize: function(options) {
      this.route(/([0-9]+)/, "conversationView");  // zid
      this.route(/([0-9]+)\/(.*)/, "conversationView"); // zid/zinvite
    },
    landingPageView: function() {
      var landingPageView = new LandingPageView();
      RootView.getInstance().setView(landingPageView);
    },
    inbox: function(filter){

      // TODO add to inboxview init

        // conversationsCollection.fetch({
        //     data: $.param({
        //         is_active: false,
        //         is_draft: false,
        //     }), 
        //     processData: true,
        // });
      var filterAttrs = {};
      if (filter) {
        switch(filter) {
          case "closed":
            filterAttrs.is_active = false;
            filterAttrs.is_draft = false;
          break;
         case "active":
            // fall through to default
          default:
            filterAttrs.is_active = true
  //          filterAttrs.is_draft = false;
          break;
        }
      }

      var conversationsCollection = new ConversationsCollection();
      // Let the InboxView filter the conversationsCollection.
      var inboxView = new InboxView($.extend(filterAttrs, {
        collection: conversationsCollection,
      }));
      RootView.getInstance().setView(inboxView);
  },
  homepageView: function(){
    var homepage = new HomepageView();
    RootView.getInstance().setView(homepage);
  },
  createConversation: function(){
    var that = this;
    conversationsCollection = new ConversationsCollection();

    var model = new ConversationModel({
      is_draft: true,
      is_active: true, // TODO think
    });
    model.save().then(function(data) {
      model.set('zid', data.zid);
      var createConversationFormView = new CreateConversationFormView({
        model: model,
        collection: conversationsCollection,
        add: true
      });
      that.listenTo(createConversationFormView, "all", function(eventName, data) {
        if (eventName === 'done') {
          that.inbox();
        }
      });
      RootView.getInstance().setView(createConversationFormView);
      $('[data-toggle="checkbox"]').each(function() {
        var $checkbox = $(this);
        $checkbox.checkbox();
      });
    }, function(err) {
      alert('failed to create new conversation');
      console.dir(err);
    });
  },
  editConversation: function(id) {
  	var conversationsCollection = new ConversationsCollection();
  	conversationsCollection.fetch()
    var model = conversationsCollection.get(id);
    var createConversationFormView = new CreateConversationFormView({
      model: model,
      collection: conversationsCollection,
      edit: true,
      model: model
    });
    that.listenTo(createConversationFormView, "all", function(eventName, data) {
      if (eventName === 'done') {
        that.inbox();
      }
    });
    createConversationFormView.populate(model.attributes);
    RootView.getInstance().setView(createConversationFormView);
    $('[data-toggle="checkbox"]').each(function () {
      var $checkbox = $(this);
      $checkbox.checkbox();
    });
  },
  conversationDetails: function(id){
  	var conversationsCollection = new ConversationsCollection();
  	conversationsCollection.fetch();
    var model = conversationsCollection.get(id);    
    var detailsView = new ConversationDetailsView({
      collection: conversationsCollection,
      model: model
    });
    RootView.getInstance().setView(detailsView);
  },
  conversationView: function(zid, zinvite) {					//THE CONVERzATION, VISUALIZATION, VOTING, ETC.
    var that = this;
 
    console.dir("conversationView");
    console.dir(this);
    if (!PolisStorage.uid.get()) {
        this.createOrSignIn(zid);
        return;
    }
    var model = new ConversationModel({
        id: zid, // TODO remove id
        zid: zid,
        zinvite: zinvite,
    });
    model.fetch({
      success: function() {

        console.dir("fetch success");
        var conversationView = new ConversationView({
          model: model,
          zid: zid,
        });
        console.dir("fetch success2");
        RootView.getInstance().setView(conversationView);
        console.dir("fetch success3");
      },
      error: function(e) {
        console.error('error loading conversation model', e);
        setTimeout(function() { that.conversationView(zid); }, 5000); // retry
      },
    });
  },
  createUser: function(zid){
    var that = this;
    var createUserFormView = new CreateUserFormView();
    createUserFormView.on("authenticated", function() {
      if (zid) {
        // Redirect to a specific conversation after the user signs in.
        that.conversationView(zid);
      } else {
        that.inbox();
      }
    });
    RootView.getInstance().setView(createUserFormView);
  },
  login: function(zid){
    var that = this;
    var loginFormView = new LoginFormView();
    loginFormView.on("authenticated", function() {
      if (zid) {
        // Redirect to a specific conversation after the user signs in.
        that.conversationView(zid);
      } else {
        that.inbox();
      }
    });
    RootView.getInstance().setView(loginFormView);
  }
  });
});
