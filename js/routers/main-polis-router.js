var RootView = require("../views/root");
var Backbone = require("backbone");
var ConversationModel = require("../models/conversation");
var ParticipantModel = require("../models/participant");
var bbFetch = require("../net/bbFetch");
var ConversationsCollection = require("../collections/conversations");
var FaqCollection = require("../collections/faqs");
var FaqContent = require("../faqContent");
var InboxItemForApiView = require('../views/inboxItemForApi');
var InboxView = require("../views/inbox");
var HomepageView = require("../views/homepage");
var CreateConversationFormView = require("../views/create-conversation-form");
var ConversationDetailsView = require("../views/conversation-details");
var ConversationGatekeeperView = require("../views/conversationGatekeeperView");
var ConversationGatekeeperViewCreateUser = require("../views/conversationGatekeeperViewCreateUser");
var ParticipationView = require("../views/participation");
var ExploreView = require("../views/explore");
var EmptyView = require("../views/empty-view");
var LoginFormView = require("../views/login-form");
var metric = require("../util/metric");
var ModerationView = require("../views/moderation");
var PasswordResetView = require("../views/passwordResetView");
var PasswordResetInitView = require("../views/passwordResetInitView");
var SettingsView = require("../views/settings.js");
var ShareLinkView = require("../views/share-link-view");
var SummaryView = require("../views/summary.js");
var PlanUpgradeView = require("../views/plan-upgrade");
var FaqView = require("../views/faq");
var PolisStorage = require("../util/polisStorage");
var UserModel = require("../models/user");
var _ = require("underscore");
var $ = require("jquery");


function authenticated() { return PolisStorage.uid(); }
function hasEmail() { return PolisStorage.hasEmail(); }

// TODO refactor this terrible recursive monster function.
function doJoinConversation(onSuccess, sid, zinvite, singleUse) {
  var that = this;

  var suzinvite;
  if (singleUse) {
    suzinvite = zinvite;
  }

  var uid = PolisStorage.uid();

  if (!uid) {
      console.log("trying to load conversation, but no auth");
      // Not signed in.
      // Or not registered.

      if (singleUse) {

        $.ajax({
          url: "/v3/joinWithInvite",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: {
            sid: sid,
            suzinvite: suzinvite
          }
        }).then(function(data) {
          that.participationView(sid);
        }, function(err) {
          if (err.responseText === "polis_err_no_matching_suzinvite") {
            alert("Sorry, this single-use URL has been used.");
          } else {
            that.conversationGatekeeper(sid, suzinvite, singleUse).done(function(ptptData) {
              doJoinConversation.call(that, onSuccess, sid);
            });
          }
        });
      } else if (sid) {
        // Don't require user to explicitly create a user before joining the conversation.
        $.ajax({
          url: "/v3/joinWithInvite",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: {
            sid: sid
          }
        }).then(function(data) {
          that.participationView(sid);
        }, function(err) {
          that.conversationGatekeeper(sid, zinvite).done(function(ptptData) {
            doJoinConversation.call(that, onSuccess, sid);
          });
        });
      } else {
        alert("missing conversation ID in URL. Shouldn't hit this.");
        // this.doCreateUserFromGatekeeper(sid, zinvite, singleUse).done(function() {
        //   // Try again, should be ready now.
        //   doJoinConversation.call(that, onSuccess, sid, zinvite);
        // });


        // !!!!!!!!!!TEMP CODE - JOIN WITHOUT A ZINVITE!!!!!
        // Don't require user to explicitly create a user before joining the conversation.
        $.ajax({
          url: "/v3/joinWithInvite",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: {
            sid: sid,
            // zinvite: zinvite
          }
        }).then(function(data) {
          that.participationView(sid);
        }, function(err) {
          that.conversationGatekeeper(sid).done(function(ptptData) {
            doJoinConversation.call(that, onSuccess, sid);
          });
        });

      }
  } else {
    var params = {
      sid: sid,
    };
    if (singleUse) {
      params.suzinvite = suzinvite;
    } else {
      params.zinvite = zinvite;
    }

    if (singleUse) {
      // join conversation (may already have joined)
      var ptpt = new ParticipantModel(params);
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        onSuccess(ptpt);
      }, function(err) {
        $.ajax({
          url: "/v3/joinWithInvite",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: {
            sid: sid,
            suzinvite: suzinvite
          }
        }).then(function(data) {
          doJoinConversation.call(that, onSuccess, sid);
        }, function(err) {
          if (err.responseText === "polis_err_no_matching_suzinvite") {
            alert("Sorry, this single-use URL has been used.");
          } else {
            that.conversationGatekeeper(sid, suzinvite, singleUse).done(function(ptptData) {
              doJoinConversation.call(that, onSuccess, sid);
            });
          }
        });
      });
    } else {
      // join conversation (may already have joined)
      var ptpt = new ParticipantModel(params);
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        onSuccess(ptpt);
      }, function(err) {
        that.conversationGatekeeper(sid, zinvite).done(function(ptptData) {
          doJoinConversation.call(that, onSuccess, sid, zinvite);
        });
      });
    }
  }
  //  else {
  //   // Found a pid for that sid.
  //   // Go to the conversation.
  //   that.doLaunchConversation(sid);
  // }

}


var polisRouter = Backbone.Router.extend({
  initialize: function(options) {
    this.r("homepage", "homepageView");
    this.r("conversation/create", "createConversation");
    this.r("conversation/view/:id(/:zinvite)", "participationView");
    this.r("user/create", "createUser");
    this.r("user/login", "login");
    this.r("user/logout", "deregister");
    this.r("welcome/:einvite", "createUserViewFromEinvite");
    this.r("settings", "settings");
    this.r("plan/upgrade(/:plan_id)", "upgradePlan");
    this.r("inbox(/:filter)", "inbox");
    this.r("faq", "faq");
    this.r("pwresetinit", "pwResetInit");
    this.r("prototype", "prototype");
    this.r("", "landingPageView");



    // backwards compatibility TODO remove after July 2014
    this.r(/^([0-9]+)/, "participationViewDeprecated");  // zid
    this.r(/^([0-9]+)\/(.*)/, "participationViewDeprecated"); // zid/zinvite
    this.r(/^m\/([0-9]+)/, "moderationViewDeprecated");  // m/zid
    this.r(/^m\/([0-9]+)\/(.*)/, "moderationViewDeprecated"); // m/zid/zinvite
    // end backwards compatibility routes

    this.r(/^([0-9][0-9A-Za-z]+)$/, "participationView");  // sid
    this.r(/^ot\/([0-9][0-9A-Za-z]+)\/(.*)/, "participationViewWithSuzinvite"); // ot/sid/suzinvite
    this.r(/^pwreset\/(.*)/, "pwReset");
    this.r(/^demo\/([0-9][0-9A-Za-z]+)/, "demoConversation");

    this.r(/^explore\/([0-9][0-9A-Za-z]+)$/, "exploreView");  // explore/sid
    this.r(/^share\/([0-9][0-9A-Za-z]+)$/, "shareView");  // share/sid
    this.r(/^summary\/([0-9][0-9A-Za-z]+)$/, "summaryView");  // summary/sid
    this.r(/^m\/([0-9][0-9A-Za-z]+)$/, "moderationView");  // m/sid
    this.r(/^iip\/([0-9][0-9A-Za-z]+)$/, "inboxItemParticipant");
    this.r(/^iim\/([0-9][0-9A-Za-z]+)$/, "inboxItemModerator");

    var routesWithFooter = [
      /^faq/,
      /^settings/,
      /^summaryView/,
      /^inbox$/,
      /^moderationView/,
      /^pwResetInit/,
      /^pwReset/,
      /^exploreView/,
      /^createConversation/
    ];
    function needsFooter(route) {
      return _.some(routesWithFooter, function(regex){
        return route.match(regex)
      });
    }
    this.on("route", function(route, params) {
      if (needsFooter(route)) {
        $('[data-view-name="root"]').addClass("wrap");
        var footer = $("#footer").detach();
        $(document.body).append(footer);
        $("#footer").show();
      } else {
        $("#footer").hide();
        $('[data-view-name="root"]').removeClass("wrap");
      }
    });


  },
  r: function(pattern, methodToCall) {
    metric("route", methodToCall);
    this.route(pattern, methodToCall);
  },
  bail: function() {
    this.navigate("/", {trigger: true});
  },
  prototype: function() {
    var view = new EmptyView();
    RootView.getInstance().setView(view);
  },
  upgradePlan: function(plan_id) {
    var promise;
    if (!authenticated()) {
      window.planId = plan_id;
      promise = this.doLogin(false);
    } else if (!hasEmail()) {
      window.planId = plan_id;
      promise = this.doLogin(true);
    } else {
      if (_.isUndefined(plan_id) && !_.isUndefined(window.plan_id)) {
        plan_id = window.planId;
      }
      promise = $.Deferred().resolve();
    }
    promise.then(function() {
      var userModel = new UserModel();
      bbFetch(userModel).then(function() {
        var view = new PlanUpgradeView({
          model: userModel,
          plan_id: plan_id,
        });
        RootView.getInstance().setView(view);
      });
    });

  },
  inboxItemParticipant: function(sid) {
    var model = new Backbone.Model({
      sid: sid,
      participant_count: 0,
      topic: "Placeholder Topic",
      description: "Placeholder Description",
      url_name: "https://preprod.pol.is/" + sid,
      url_name_with_hostname: "https://preprod.pol.is/" + sid,
      // url_moderate: "https://pol.is/m/" + sid,
      target: "_blank",
      is_owner: false,
    })
    var view = new InboxItemForApiView({
      model: model
    });
    RootView.getInstance().setView(view);
  },
  inboxItemModerator: function(sid) {
    var model = new Backbone.Model({
      sid: sid,
      participant_count: 0,
      topic: "Placeholder Topic",
      description: "Placeholder Description",
      url_name: "https://pol.is/" + sid,
      url_name_with_hostname: "https://pol.is/" + sid,
      url_moderate: "https://pol.is/m/" + sid,
      target: "_blank",
      is_owner: true,
    })
    var view = new InboxItemForApiView({ // TODO moderator specific
      model: model
    });
    RootView.getInstance().setView(view);
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
  settings: function() {
    var promise = $.Deferred().resolve();
    if (!authenticated()) {
      promise = this.doLogin(false);
    } else if (!hasEmail()) {
      promise = this.doLogin(true);
    }
    promise.then(function() {
      var userModel = new UserModel();
      bbFetch(userModel).then(function() {
          var view = new SettingsView({
          model: userModel,
        });
        RootView.getInstance().setView(view);
      });
    });
  },
  deregister: function() {
    window.deregister();
  },
  shareView: function(sid) {
    var that = this;
    var data = {
      sid: sid
    };
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      var view = new ShareLinkView({
        model: model
      });
      RootView.getInstance().setView(view);
    },function(e) {
      console.error("error loading conversation model", e);
    });
  },
  inbox: function(filter){
    var promise = $.Deferred().resolve();
    if (!authenticated()) {
      promise = this.doLogin(false);
    } else if (!hasEmail()) {
      promise = this.doLogin(true);
    }
    promise.then(function() {
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
    });
  },
  homepageView: function(){
    var homepage = new HomepageView();
    RootView.getInstance().setView(homepage);
  },
  createConversation: function(){
    var promise = $.Deferred().resolve();
    if (!authenticated()) {
      promise = this.doLogin(false);
    } else if (!hasEmail()) {
      promise = this.doLogin(true);
    }
    var that = this;
    promise.then(function() {
      function onFail(err) {
        alert("failed to create new conversation");
        console.dir(err);
      }
      conversationsCollection = new ConversationsCollection();

      var model = new ConversationModel({
        is_draft: true,
        is_active: true // TODO think
      });

      model.save().then(function(data) {
        var sid = data[0][0].sid;
        model.set("sid", sid);

        var ptpt = new ParticipantModel({
          sid: sid
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
            // NOTE suurls broken for now
            // var suurls = data;
            //   if (suurls) {
            //   var suurlsCsv = [];
            //   var len = suurls.xids.length;
            //   var xids = suurls.xids;
            //   var urls = suurls.urls;
            //   for (var i = 0; i < len; i++) {
            //     suurlsCsv.push({xid: xids[i], url: urls[i]});
            //   }
            //   model.set("suurls", suurlsCsv);
            // }

            that.navigate("share/" + model.get("sid"), {trigger: true});
          }
        });
        RootView.getInstance().setView(createConversationFormView);
        $("[data-toggle='checkbox']").each(function() {
          var $checkbox = $(this);
          $checkbox.checkbox();
        });
      }, onFail);
    });
  },
  doLaunchConversation: function(ptptModel) {
    var sid = ptptModel.get("sid");
    var pid = ptptModel.get("pid");
    
    var data = {
      sid: sid
    };

    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      var participationView = new ParticipationView({
        pid: pid,
        model: model
      });
      RootView.getInstance().setView(participationView);
    },function(e) {
      console.error("error loading conversation model", e);
    });
  },

  doLaunchExploreView: function(ptptModel) {
    var sid = ptptModel.get("sid");
    var pid = ptptModel.get("pid");
    
    var data = {
      sid: sid
    };
    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      var exploreView = new ExploreView({
        pid: pid,
        model: model
      });
      RootView.getInstance().setView(exploreView);
    },function(e) {
      console.error("error loading conversation model", e);
    });
  },
  doLaunchSummaryView: function(ptptModel) {
    var sid = ptptModel.get("sid");
    var pid = ptptModel.get("pid");
    
    var data = {
      sid: sid
    };
    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      var view = new SummaryView({
        pid: pid,
        model: model
      });
      RootView.getInstance().setView(view);
    },function(e) {
      console.error("error loading conversation model", e);
    });
  },
  doLaunchModerationView: function(ptptModel) {
    var sid = ptptModel.get("sid");
    var pid = ptptModel.get("pid");
    
    var data = {
      sid: sid
    };
    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      if (!model.get("is_owner")) {
        alert("Sorry, only the conversation owner can moderate this conversation.");
        return;
      }
      var view = new ModerationView({
        pid: pid,
        model: model
      });
      RootView.getInstance().setView(view);
    },function(e) {
      console.error("error loading conversation model", e);
    });
  },


  demoConversation: function(sid) {
    var ptpt = new ParticipantModel({
      sid: sid,
      pid: -123 // DEMO_MODE
    });

    // NOTE: not posting the model

    this.doLaunchConversation(ptpt);
  },
  participationViewWithSuzinvite: function(sid, suzinvite) {
    window.suzinvite = suzinvite;
    return this.participationView(sid, suzinvite, true);
  },
  exploreView: function(sid, zinvite) {
    doJoinConversation.call(this, 
      this.doLaunchExploreView.bind(this), // TODO
      sid,
      zinvite);
  },
  summaryView: function(sid, zinvite) {
    doJoinConversation.call(this, 
      this.doLaunchSummaryView.bind(this), // TODO
      sid,
      zinvite);
  },

  moderationView: function(sid, zinvite) {
    doJoinConversation.call(this, 
      this.doLaunchModerationView.bind(this), // TODO
      sid,
      zinvite);
  },
  moderationViewDeprecated: function(sid, zinvite) {
    doJoinConversation.call(this, 
      this.doLaunchModerationView.bind(this), // TODO
      zinvite); // maps to sid
  },
  participationView: function(sid, zinvite, singleUse) {

    doJoinConversation.call(this, 
      this.doLaunchConversation.bind(this),
      sid,
      zinvite,
      singleUse);

  },
  participationViewDeprecated: function(zid, zinvite, singleUse) {
    doJoinConversation.call(this, 
      this.doLaunchConversation.bind(this),
      zinvite); // maps to sid now
  },
  
  // assumes the user already exists.
  conversationGatekeeper: function(sid, suzinvite, singleUse) {
    var dfd = $.Deferred();
    var data = {
      sid: sid
    };
    if (singleUse) {
      data.suzinvite = suzinvite
    }
    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      data.model = model;
      var gatekeeperView = new ConversationGatekeeperView(data);
      gatekeeperView.on("done", dfd.resolve);
      RootView.getInstance().setView(gatekeeperView);
    }, dfd.reject);

    return dfd.promise();
  },
  doCreateUserFromGatekeeper: function(sid, zinvite, singleUse) {
    var dfd = $.Deferred();

    var data = {
      create: true, // do we need this?
      sid: sid
    };
    if (singleUse) {
      data.suzinvite = suzinvite
    }
    // Assumes you have a pid already.
    var model = new ConversationModel(data);
    bbFetch(model, {
      data: $.param(data),
      processData: true
    }).then(function() {
      var view = new ConversationGatekeeperViewCreateUser({
        model : model
      });
      view.on("authenticated", dfd.resolve);
      RootView.getInstance().setView(view);
    },function(e) {
      console.error("error loading conversation model", e);
      setTimeout(function() { that.participationView(sid); }, 5000); // retry
    });
    return dfd.promise();
  },
  redirect: function(path) {
    document.location = document.location.protocol + "//" + document.location.host + path;
  },
  createUser: function(){
    var that = this;
    this.doLogin(true).done(function() {
    // this.doCreateUser().done(function() {

        // trash the JS context, don't leave password sitting around
        that.redirect("/inbox");

      // that.inbox();
    });
  },
  createUserViewFromEinvite: function(einvite) {
    var that = this;
    var model = {
      einvite: einvite,
      hideHaveAccount: true,
      readonlyEmail: true,
      create: true
    };
    $.getJSON("/v3/einvites?einvite=" + einvite).then(function(o) {
      model.email = o.email;      
      return model;
    }, function() {
      // einvite lookup failed somehow, go ahead and show the form - the user will have to enter their email again.
      console.error("einvite lookup failed");
      return $.Deferred().resolve(model);
    }).then(function(model) {
      var view = new ConversationGatekeeperViewCreateUser({
        model: new Backbone.Model(model)
      });
      view.on("authenticated", function() {
        // trash the JS context, don't leave password sitting around
        that.redirect("/inbox");
      });
      RootView.getInstance().setView(view);
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
    RootView.getInstance().setView(view );
  },
  doLogin: function(create) {
    var dfd = $.Deferred();
    var gatekeeperView = new ConversationGatekeeperViewCreateUser({
      model: new Backbone.Model({
        create: create
      })
    });
    gatekeeperView.on("authenticated", dfd.resolve);
    RootView.getInstance().setView(gatekeeperView);
    return dfd.promise();
  },
  login: function(){
    var that = this;
    this.doLogin(false).done(function() {
        // trash the JS context, don't leave password sitting around
        that.redirect("/inbox");
    });
  },
  faq: function(){
    var faqCollection = new FaqCollection(FaqContent)
    var faqView = new FaqView({collection: faqCollection});
    RootView.getInstance().setView(faqView);
  }
});

 module.exports = polisRouter;