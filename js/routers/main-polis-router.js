var eb = require("../eventBus");
var RootView = require("../views/root");
var Backbone = require("../backbone");
var ConversationModel = require("../models/conversation");
var ParticipantModel = require("../models/participant");
var bbFetch = require("../net/bbFetch");
var ConversationsCollection = require("../collections/conversation");
var InboxView = require("../views/inbox");
var HomepageView = require("../views/homepage");
var CreateConversationFormView = require("../views/create-conversation-form");
var ConversationDetailsView = require("../views/conversation-details");
var ConversationGatekeeperView = require("../views/conversationGatekeeperView");
var ConversationGatekeeperViewCreateUser = require("../views/conversationGatekeeperViewCreateUser");
var ConversationView = require("../views/conversation-view");
var CreateUserFormView = require("../views/create-user-form");
var LoginFormView = require("../login-form");
var LandingPageView = require("../landing-page");
var PasswordResetView = require("../views/passwordResetView");
var ShareLinkView = require("../views/share-link-view");
var PolisStorage = require("../util/polisStorage");
var $ = require("jquery");

function authenticated() {
  return PolisStorage.uid();
}

var polisRouter = Backbone.Router.extend({
  routes: {
    "homepage": "homepageView",
    "conversation/create": "createConversation",
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
        break;
        default:
          filterAttrs.is_active = true;
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
          //that.inbox();
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
 var originalNavigate = polisRouter.navigate;
 polisRouter.navigate = function() {
  alert("triggering exit");
  eb.trigger(eb.exit);
  originalNavigate.apply(polisRouter, arguments);
 };

 module.exports = polisRouter;