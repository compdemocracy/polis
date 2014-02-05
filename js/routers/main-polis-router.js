define([  //begin dependencies
  "views/root",
  "backbone",
  "models/conversation",
  "models/participant",
  "net/bbFetch",
  "collections/conversations",
  "views/inbox",
  "views/homepage",
  "views/create-conversation-form",
  "views/conversation-details",
  "views/conversationGatekeeperView",
  "views/conversationGatekeeperViewCreateUser",
  "views/conversation-view",
  "views/create-user-form",
  "views/login-form",
  "views/landing-page",
  "views/passwordResetInitView",
  "views/passwordResetView",
  "views/share-link-view",
  "util/polisStorage",
  "jquery"
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
    PasswordResetInitView,
    PasswordResetView,
    ShareLinkView,
    PolisStorage,
    $
	) {  //end args, begin function block

  function authenticated() {
    return PolisStorage.uid();
  }

  

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
      "pwresetinit" : "pwResetInit",
      "": "landingPageView"
      // see others in the initialize method
    },
    initialize: function(options) {
      this.route(/([0-9]+)/, "conversationView");  // zid
      this.route(/([0-9]+)\/(.*)/, "conversationView"); // zid/zinvite
      this.route(/^pwreset\/(.*)/, "pwReset");
      this.route(/^demo\/(.*)/, "demoConversation");
    },
    bail: function() {
      this.navigate("/", {trigger: true});
    },
    landingPageView: function() {
      if (!authenticated()) {

        this.navigate("user/create", {trigger: true});

        // RootView.getInstance().setView(new LandingPageView());
        // RootView.getInstance().setView(new CreateUserFormView({
        //   model : new Backbone.Model({
        //     // zinvite: zinvite,
        //     create: true
        //   })
        // }));
      } else {
        // this.inbox();
        this.navigate("inbox", {trigger: true});
      }
    },
    deregister: function() {
      window.deregister();
    },
    gotoShareView: function(conversationModel) {
      var that = this;
      var shareLinkView = new ShareLinkView({
        model: conversationModel
      });

      shareLinkView.on("done", function() {
        var zid = conversationModel.get("zid");
        var zinvite = conversationModel.get("zinvites")[0];
        var path = zid + (zinvite ? "/"+zinvite : "");
        that.navigate(path, {trigger: true});
      });

      RootView.getInstance().setView(shareLinkView);
    },

    inbox: function(filter){
      if (!authenticated()) { return this.bail(); }
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
        collection: conversationsCollection
      }));
      RootView.getInstance().setView(inboxView);
  },
  homepageView: function(){
    var homepage = new HomepageView();
    RootView.getInstance().setView(homepage);
  },
  createConversation: function(){
    if (!authenticated()) { return this.bail(); }
    function onFail(err) {
      alert("failed to create new conversation");
      console.dir(err);
    }
    var that = this;
    conversationsCollection = new ConversationsCollection();

    var model = new ConversationModel({
      is_draft: true,
      is_active: true // TODO think
    });

    model.save().then(function(data) {
      model.set("zid", data.zid);

      var ptpt = new ParticipantModel({
        zid: data.zid
      });
      return ptpt.save();
    }).then(function(ptptAttrs) {
      var createConversationFormView = new CreateConversationFormView({
        model: model,
        collection: conversationsCollection,
        pid: ptptAttrs.pid,
        add: true
      });
      that.listenTo(createConversationFormView, "all", function(eventName, data) {
        if (eventName === "done") {
          that.gotoShareView(model);
          // that.navigate("inbox", {trigger: true});
//          that.inbox();
        }
      });
      RootView.getInstance().setView(createConversationFormView);
      $("[data-toggle='checkbox']").each(function() {
        var $checkbox = $(this);
        $checkbox.checkbox();
      });
    }, function(err) {
      // try with an oinvite
      var oinvite = window.prompt("Please enter beta invite code:");
      return $.ajax({
        url: "/v3/users",
        type: "PUT",
        data: {
          oinvite: oinvite,
          is_owner: true
        }
      }).done(function() {
        // Try again now that we should have permissions to create conversations.
        that.createConversation();
      });
    }).fail(onFail);
  },
  editConversation: function(id) {
    if (!authenticated()) { return this.bail(); }

    var that = this;
    var conversationsCollection = new ConversationsCollection();
    conversationsCollection.fetch();
    var model = conversationsCollection.get(id);
    var createConversationFormView = new CreateConversationFormView({
      model: model,
      collection: conversationsCollection,
      edit: true
    });
    that.listenTo(createConversationFormView, "all", function(eventName, data) {
      if (eventName === "done") {
        that.gotoShareView(model);
        // that.navigate("inbox", {trigger: true});
        // that.inbox();
      }
    });
    createConversationFormView.populate(model.attributes);
    RootView.getInstance().setView(createConversationFormView);
    $("[data-toggle='checkbox']").each(function () {
      var $checkbox = $(this);
      $checkbox.checkbox();
    });
  },
  conversationDetails: function(id){
    if (!authenticated()) { return this.bail(); }

    var conversationsCollection = new ConversationsCollection();
    conversationsCollection.fetch();
    var model = conversationsCollection.get(id);
    var detailsView = new ConversationDetailsView({
      collection: conversationsCollection,
      model: model
    });
    RootView.getInstance().setView(detailsView);
  },

  doLaunchConversation: function(ptptModel) {
    var zid = ptptModel.get("zid");
    var pid = ptptModel.get("pid");
    
    // Assumes you have a pid already.
    var model = new ConversationModel({
        zid: zid
    });
    bbFetch(model).then(function() {
      var conversationView = new ConversationView({
        pid: pid,
        model: model
      });
      RootView.getInstance().setView(conversationView);
    },function(e) {
      console.error("error loading conversation model", e);
      setTimeout(function() { that.conversationView(zid); }, 5000); // retry
    });
  },

  demoConversation: function(zid) {
    var ptpt = new ParticipantModel({
      zid: zid,
      pid: -123 // DEMO_MODE
    });

    // NOTE: not posting the model

    this.doLaunchConversation(ptpt);
  },
  conversationView: function(zid, zinvite) {					//THE CONVERzATION, VISUALIZATION, VOTING, ETC.
    if (!zinvite && !authenticated()) { return this.bail(); }

    var that = this;

    var uid = PolisStorage.uid();

    if (!uid) {
        console.log("trying to load conversation, but no auth");
        // Not signed in.
        // Or not registered.
        this.doCreateUserFromGatekeeper(zinvite).done(function() {
          // Try again, should be ready now.
          that.conversationView(zid, zinvite);
        });
    } else {
      // join conversation (may already have joined)
      var ptpt = new ParticipantModel({
        zid: zid,
        zinvite: zinvite
      });
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        that.doLaunchConversation(ptpt);
      }, function(err) {
        that.conversationGatekeeper(zid, uid, zinvite).done(function(ptptData) {
          that.conversationView(zid, zinvite);
        });
      });
    }
    //  else {
    //   // Found a pid for that zid.
    //   // Go to the conversation.
    //   that.doLaunchConversation(zid);
    // }
  },
  // assumes the user already exists.
  conversationGatekeeper: function(zid, uid, zinvite) {
    var dfd = $.Deferred();
    var gatekeeperView = new ConversationGatekeeperView({
      zid: zid,
      uid: uid,
      zinvite: zinvite
    });
    gatekeeperView.on("done", dfd.resolve);
    RootView.getInstance().setView(gatekeeperView);
    return dfd.promise();
  },
  doCreateUserFromGatekeeper: function(zinvite) {
    var dfd = $.Deferred();

    var createUserFormView = new ConversationGatekeeperViewCreateUser({
      model : new Backbone.Model({
        zinvite: zinvite,
        create: true
      })
    });
    createUserFormView.on("authenticated", dfd.resolve);
    RootView.getInstance().setView(createUserFormView);
    return dfd.promise();
  },
  doCreateUser: function(zinvite){
    var dfd = $.Deferred();

    var createUserFormView = new CreateUserFormView({
      model : new Backbone.Model({
        zinvite: zinvite,
        create: true
      })
    });
    createUserFormView.on("authenticated", dfd.resolve);
    RootView.getInstance().setView(createUserFormView);
    return dfd.promise();
  },
  createUser: function(){
    var that = this;
    this.doCreateUser().done(function() {
      that.navigate("inbox", {trigger: true});
      // that.inbox();
    });
  },
  pwReset: function(pwresettoken) {
    var view = new PasswordResetView({
      pwresettoken: pwresettoken
    });
    RootView.getInstance().setView(view);
  },
  pwResetInit: function() {
    var view = new PasswordResetInitView();
    RootView.getInstance().setView(view);
  },
  login: function(zid){
    var that = this;
    var loginFormView = new LoginFormView();
    loginFormView.on("authenticated", function() {
      if (zid) {
        // Redirect to a specific conversation after the user signs in.
        that.conversationView(zid);
      } else {
        that.navigate("inbox", {trigger: true});
        // that.inbox();
      }
    });
    RootView.getInstance().setView(loginFormView);
  }
  });
});
