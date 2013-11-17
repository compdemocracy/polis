define([  //begin dependencies
  'views/root',
  'backbone',
  'models/conversation',
  'models/participant',
  'net/bbFetch',
  'collections/conversations',
  'views/inbox',
  'views/homepage',
  'views/create-conversation-form',
  'views/conversation-details',
  'views/conversationGatekeeperView',
  'views/conversationGatekeeperViewCreateUser',
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
    ParticipantModel,
    bbFetch,
		ConversationsCollection, 
		InboxView, 
		HomepageView, 
		CreateConversationFormView,
		ConversationDetailsView,
    ConversationGatekeeperView,
    ConversationGatekeeperViewCreateUser,
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
      "settings": "deregister",
      "inbox(/:filter)": "inbox",
      "": "landingPageView",
      // see others in the initialize method
    },
    initialize: function(options) {
      this.route(/([0-9]+)/, "conversationView");  // zid
      this.route(/([0-9]+)\/(.*)/, "conversationView"); // zid/zinvite
    },
    landingPageView: function() {
      if (!PolisStorage.uid.get()) {
        var landingPageView = new LandingPageView();
        RootView.getInstance().setView(landingPageView);
      } else {
        // this.inbox();
        Backbone.history.navigate("inbox", {trigger: true});
      }
    },
    deregister: function() {
      window.deregister();
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
            filterAttrs.is_active = true;
  //          filterAttrs.is_draft = false;
          break;
          default:
            filterAttrs.is_active = true;
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
          Backbone.history.navigate("inbox", {trigger: true});
//          that.inbox();
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
    conversationsCollection.fetch();
    var model = conversationsCollection.get(id);
    var createConversationFormView = new CreateConversationFormView({
      model: model,
      collection: conversationsCollection,
      edit: true
    });
    that.listenTo(createConversationFormView, "all", function(eventName, data) {
      if (eventName === 'done') {
        Backbone.history.navigate("inbox", {trigger: true});
        // that.inbox();
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

  doLaunchConversation: function(zid) {
    // Assumes you have a pid already.
    var model = new ConversationModel({
        zid: zid,
    });
    bbFetch(model).then(function() {
      var conversationView = new ConversationView({
        model: model,
        zid: zid,
      });
      RootView.getInstance().setView(conversationView);
    },function(e) {
      console.error('error loading conversation model', e);
      setTimeout(function() { that.conversationView(zid); }, 5000); // retry
    });
  },

  conversationView: function(zid, zinvite) {					//THE CONVERzATION, VISUALIZATION, VOTING, ETC.
    var that = this;

    var uid = PolisStorage.uid.get();
 
    if (!uid) {
        console.log('trying to load conversation, but no auth');
        // Not signed in.
        // Or not registered.
        this.doCreateUserFromGatekeeper(zinvite).done(function() {
          // Try again, should be ready now.
          that.conversationView(zid, zinvite);
        });
    } else if (!PolisStorage.pids.get(zid)) {
      console.log('trying to load conversation, but no pid');
      // Signed in...
      // But not yet a participant for this converation.
      // (at least from this browser)
      //
      // Try to create or fetch a participant record.
      var ptpt = new ParticipantModel({
        zid: zid,
        zinvite: zinvite,
      });
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        that.doLaunchConversation(zid);
      }, function(err) {
        that.conversationGatekeeper(zid, uid, zinvite ).done(function() {
          that.doLaunchConversation(zid);
        });
      });
    } else {
      // Found a pid for that zid.
      // Go to the conversation.
      that.doLaunchConversation(zid);
    }
  },
  // assumes the user already exists.
  conversationGatekeeper: function(zid, uid, zinvite) {
    var dfd = $.Deferred();
    var gatekeeperView = new ConversationGatekeeperView({
      zid: zid,
      uid: uid,
      zinvite: zinvite,
    });
    gatekeeperView.on('done', dfd.resolve);
    RootView.getInstance().setView(gatekeeperView);
    return dfd.promise();
  },
  doCreateUserFromGatekeeper: function(zinvite) {
    var that = this;
    var dfd = $.Deferred();

    var createUserFormView = new ConversationGatekeeperViewCreateUser({
      zinvite: zinvite,
    });
    createUserFormView.on("authenticated", dfd.resolve);
    RootView.getInstance().setView(createUserFormView);
    return dfd.promise();
  },
  doCreateUser: function(zinvite){
    var that = this;
    var dfd = $.Deferred();

    var createUserFormView = new CreateUserFormView({
      zinvite: zinvite,
    });
    createUserFormView.on("authenticated", dfd.resolve);
    RootView.getInstance().setView(createUserFormView);
    return dfd.promise();
  },
  createUser: function(){
    var that = this;
    this.doCreateUser().done(function() {
      Backbone.history.navigate("inbox", {trigger: true});      
      // that.inbox();
    });
  },
  login: function(zid){
    var that = this;
    var loginFormView = new LoginFormView();
    loginFormView.on("authenticated", function() {
      if (zid) {
        // Redirect to a specific conversation after the user signs in.
        that.conversationView(zid);
      } else {
        Backbone.history.navigate("inbox", {trigger: true});
        // that.inbox();
      }
    });
    RootView.getInstance().setView(loginFormView);
  }
  });
});
