var $ = require("jquery");
var _ = require("underscore");
var Backbone = require("backbone");
var bbFetch = require("../net/bbFetch");
var ConversationModel = require("../models/conversation");
var ConversationsCollection = require("../collections/conversations");
var eb = require("../eventBus");
var gaEvent = require("../util/gaMetric").gaEvent;
var metric = require("../util/gaMetric");
var ParticipantModel = require("../models/participant");
var ParticipationView = require("../views/participation");
var PolisStorage = require("../util/polisStorage");
var preloadHelper = require("../util/preloadHelper");
var RootView = require("../views/root");
var UserModel = require("../models/user");
var Utils = require("../util/utils");


var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;

var routeEvent = metric.routeEvent;

var authenticatedDfd = $.Deferred();
authenticatedDfd.done(function() {
  // link uid to GA userId
  // TODO update this whenever auth changes
  ga('set', 'userId', PolisStorage.uid() || PolisStorage.uidFromCookie());
});

function onFirstRender() {
  $("#mainSpinner").hide();
}

function authenticated() {
  return PolisStorage.uid() || PolisStorage.uidFromCookie() || window.authenticatedByHeader;
}

function hasEmail() {
  return PolisStorage.hasEmail();
}

// TODO refactor this terrible recursive monster function.
function doJoinConversation(args) {
  var that = this;

  var onSuccess = args.onSuccess;
  var conversation_id = args.conversation_id;
  var suzinvite = args.suzinvite;
  var subviewName = args.subviewName;




  var data = {
    conversation_id: conversation_id,
    suzinvite: suzinvite
  };
  var referrer = document.referrer; // TODO see about passing the referrer of the parent frame.
  // NOTE parent_url may be in cookie at this point, and will be picked up by the server.
  if (referrer) {
    data.referrer = referrer;
  }

  var uid = PolisStorage.uid() || PolisStorage.uidFromCookie();
  console.log("have uid", !!uid);
  if (!uid) {
    console.log("trying to load conversation, but no auth");
    // Not signed in.
    // Or not registered.

    if (suzinvite) {

      $.ajax({
        url: "/api/v3/joinWithInvite",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        // crossDomain: true,
        data: data,
      }).then(function(data) {
        window.userObject = $.extend(window.userObject, data);
        window.userObject.uid = void 0;

        that.participationView(conversation_id);
        gaEvent("Session", "create", "empty");
      }, function(err) {
        if (err.responseText === "polis_err_no_matching_suzinvite") {
          gaEvent("Session", "createFail", "polis_err_no_matching_suzinvite");
          setTimeout(function() {
            alert("Sorry, this single-use URL has been used.");
          }, 99);
        } else {
          alert("error joining conversation");
          // that.conversationGatekeeper(conversation_id, suzinvite).done(function(ptptData) {
          //   doJoinConversation.call(that, args);
          // });
        }
      });
    } else if (conversation_id) {
      // Don't require user to explicitly create a user before joining the conversation.
      $.ajax({
        url: "/api/v3/joinWithInvite",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        // crossDomain: true,
        data: data
      }).then(function(data) {
        window.userObject = $.extend(window.userObject, data);
        window.userObject.uid = void 0;

        that.participationView(conversation_id);
        gaEvent("Session", "create", "empty");
      }, function(err) {
        if (/polis_err_need_full_user/.test(err.responseText)) {

          alert("error joining conversation polis_err_need_full_user");
        } else {
          // TODO when does this happen?
          alert("error joining conversation 2");
        }
        // console.dir(err);
      });
    } else {
      gaEvent("Session", "createFail", "polis_err_unexpected_conv_join_condition_1");
      setTimeout(function() {
        alert("missing conversation ID in URL. Shouldn't hit this.");
      }, 99);


      // !!!!!!!!!!TEMP CODE - JOIN WITHOUT A ZINVITE!!!!!
      // Don't require user to explicitly create a user before joining the conversation.
      $.ajax({
        url: "/api/v3/joinWithInvite",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        // crossDomain: true,
        data: data, // zinvite: zinvite
      }).then(function(data) {
        window.userObject = $.extend(window.userObject, data);
        window.userObject.uid = void 0;
        that.participationView(conversation_id);
        gaEvent("Session", "create", "empty");
      }, function(err) {
        alert("error joining conversation 3");
      });

    }
  } else { // uid defined
    var params = {
      conversation_id: conversation_id,
    };
    if (suzinvite) {
      params.suzinvite = suzinvite;
    }
    if (referrer) {
      params.referrer = referrer;
    }

    var ptpt;
    if (suzinvite) {
      // join conversation (may already have joined)
      ptpt = new ParticipantModel(params);
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        onSuccess(_.extend({
          ptptModel: ptpt
        }, args));
      }, function(err) {
        $.ajax({
          url: "/api/v3/joinWithInvite",
          type: "POST",
          dataType: "json",
          xhrFields: {
            withCredentials: true
          },
          // crossDomain: true,
          data: {
            conversation_id: conversation_id,
            suzinvite: suzinvite
          }
        }).then(function(data) {
          window.userObject = $.extend(window.userObject, data);
          window.userObject.uid = void 0;
          doJoinConversation.call(that, args);
          // no ga session event, since they already have a uid
        }, function(err) {
          if (err.responseText === "polis_err_no_matching_suzinvite") {
            alert("Sorry, this single-use URL has been used.");
          } else {
            alert("error joining conversation 3");
          }
        });
      });
    } else { // !singleUse
      // join conversation (may already have joined)
      ptpt = new ParticipantModel(params);
      ptpt.save().then(function() {
        // Participant record was created, or already existed.
        // Go to the conversation.
        onSuccess(_.extend({
          ptptModel: ptpt
        }, args));
        // no ga session event, since they already have a uid
      }, function(err) {
        if (err && err.length && err[0] && err[0].length && err[0][0].responseText.match("lti_user")) {
          alert("Before joining, you must link this account to your Canvas account. Look for an assignment called \"setup pol.is\".");
        } else {
          // not sure if this path works, or ever occurs
          alert("error joining conversation 4");
        }
      });
    }
  }
  //  else {
  //   // Found a pid for that conversation_id.
  //   // Go to the conversation.
  //   that.doLaunchConversation(conversation_id);
  // }

} // end doJoinConversation


var polisRouter = Backbone.Router.extend({
  gotoRoute: function(route, options) {
    // this.navigate(route, options);
    window.location = route;
  },
  initialize: function(options) {
    this.r(/^conversation\/create(\/ep1_[0-9A-Za-z]+)?/, "createConversation");
    this.r("user/create(/:params)", "createUser");
    this.r(/^user\/logout(\/.+)/, "deregister");
    this.r("welcome/:einvite", "createUserViewFromEinvite");
    this.r("", "landingPageView");

    this.r(/^([0-9][0-9A-Za-z]+)\/?(\?.*)?$/, "participationViewWithQueryParams"); // conversation_id / query params
    this.r(/^([0-9][0-9A-Za-z]+)(\/ep1_[0-9A-Za-z]+)?$/, "participationView"); // conversation_id / encodedStringifiedJson
    this.r(/^ot\/([0-9][0-9A-Za-z]+)\/(.*)/, "participationViewWithSuzinvite"); // ot/conversation_id/suzinvite
    this.r(/^demo\/([0-9][0-9A-Za-z]+)/, "demoConversation");
    //this.r(/^summary\/([0-9][0-9A-Za-z]+)$/, "summaryView");  // summary/conversation_id

    var routesWithFooter = [
      /^summaryView/,
      /^createConversation/
    ];

    function needsFooter(route) {
      return _.some(routesWithFooter, function(regex) {
        return route.match(regex);
      });
    }
    this.on("route", function(route, params) {
      // if (needsFooter(route)) {
      //   $('[data-view-name="root"]').addClass("wrap");
      //   var footer = $("#footer").detach();
      //   $(document.body).append(footer);
      //   $("#footer").show();
      // } else {
      // $("#footer").hide();
      // $('[data-view-name="root"]').removeClass("wrap");
      // }
    });
    eb.once(eb.firstRender, function() {
      onFirstRender();
    });


    if (authenticated()) {
      authenticatedDfd.resolve();
    }

  }, // end initialize
  r: function(pattern, methodNameToCall) {
    var that = this;
    this.route(pattern, function() {
      routeEvent(methodNameToCall, arguments);
      that[methodNameToCall].apply(that, arguments);
    });
  },
  bail: function() {
    this.gotoRoute("/", {
      trigger: true
    });
  },
  landingPageView: function() {
    if (!authenticated()) {
      this.gotoRoute("/user/create", {
        trigger: true
      });
      // RootView.getInstance().setView(new LandingPageView());
      // RootView.getInstance().setView(new CreateUserFormView({
      //   model : new Backbone.Model({
      //     // zinvite: zinvite,
      //     create: true
      //   })
      // }));
    } else {
      // this.inbox();
      this.gotoRoute("/inbox", {
        trigger: true
      });
    }
  },
  deregister: function(dest) {
    window.deregister(dest);
  },
  doLaunchConversation2: function(conversation_id, args) {

    // Since nextComment is pretty slow, fire off the request way early (this actually happens on the js on index.html now) and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = preloadHelper.firstCommentPromise;

    this.getConversationModel(conversation_id).then(function(model) {

      if (!_.isUndefined(args.vis_type)) {
        // allow turning on the vis from the URL.
        if (model.get("is_mod")) {
          model.set("vis_type", Number(args.vis_type));
        }
      }
      var participationView = new ParticipationView({
        wipCommentFormText: args.wipCommentFormText,
        model: model,
        finishedTutorial: userObject.finishedTutorial,
        firstCommentPromise: firstCommentPromise
      });
      RootView.getInstance().setView(participationView);
    }, function(e) {
      console.error("error3 loading conversation model");
    });
  },

  doLaunchConversation: function(args) {
    var ptptModel = args.ptptModel;
    var conversation_id = ptptModel.get("conversation_id");

    // Since nextComment is pretty slow, fire off the request way early and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = $.get("/api/v3/nextComment?not_voted_by_pid=mypid&limit=1&include_social=true&conversation_id=" + conversation_id);

    this.getConversationModel(conversation_id).then(function(model) {

      if (!_.isUndefined(args.vis_type)) {
        // allow turning on the vis from the URL.
        if (model.get("is_mod")) {
          model.set("vis_type", Number(args.vis_type));
        }
      }
      var participationView = new ParticipationView({
        wipCommentFormText: args.wipCommentFormText,
        model: model,
        ptptModel: ptptModel,
        finishedTutorial: userObject.finishedTutorial,
        firstCommentPromise: firstCommentPromise
      });
      RootView.getInstance().setView(participationView);
    }, function(e) {
      console.error("error3 loading conversation model");
    });
  },

  demoConversation: function(conversation_id) {
    var ptpt = new ParticipantModel({
      conversation_id: conversation_id,
      pid: -123 // DEMO_MODE
    });

    // NOTE: not posting the model

    this.doLaunchConversation({
      ptptModel: ptpt
    });
  },
  participationViewWithSuzinvite: function(conversation_id, suzinvite) {
    window.suzinvite = suzinvite;
    return this.participationView(conversation_id, null, suzinvite);
  },
  tryCookieThing: function() {
    function browserCompatibleWithRedirectTrick() {
      var ua = navigator.userAgent;
      if (ua.match(/Firefox/)) {
        // if (ua.match(/Android/)) {
        //   return false;
        // }
        // return true;
        return false;
      } else if (ua.match(/Trident/)) { // IE8+
        return true;
      } else if (ua.match(/Chrome/)) {
        return false;
      } else if (ua.match(/Safari/)) { // would include Chrome, but we handled Chrome above
        return true;
      } else {
        return false;
      }
    }

    // if our script is running on a page in which we're embedded, postmessage
    if (top.postMessage && browserCompatibleWithRedirectTrick()) {
      top.postMessage("cookieRedirect", "*");
    }

    // don't need this view, since we have the auth header, which lets us set up a temporary session.

    // // give the polisHost script enough time to navigate away (if it's listening) before showing the cookiesDisabledView
    // setTimeout(function() {
    //   // TODO emit GA event here
    //   var view = new CookiesDisabledView();
    //   RootView.getInstance().setView(view);
    // }, 500);
  },
  participationView: function(conversation_id, encodedStringifiedJson, suzinvite) {
    if (!Utils.cookiesEnabled()) {
      this.tryCookieThing();
    }
    var params = {};
    if (encodedStringifiedJson) {
      encodedStringifiedJson = encodedStringifiedJson.slice(1);
      params = Utils.decodeParams(encodedStringifiedJson);
    }

    this.doLaunchConversation2(conversation_id, params);

    // var that = this;
    // // this.doShowTutorial().then(function() {
    //   doJoinConversation.call(that, _.extend(params, {
    //     suzinvite: suzinvite,
    //     onSuccess: that.doLaunchConversation.bind(that), // TODO
    //     conversation_id: conversation_id
    //   }));
    // // });
  },
  participationViewWithQueryParams: function(conversation_id, queryParamString) {
    if (!Utils.cookiesEnabled()) {
      this.tryCookieThing();
    }

    var params = Utils.parseQueryParams(queryParamString);
    var that = this;
    this.doLaunchConversation2(conversation_id, params);

    // // this.doShowTutorial().then(function() {
    //   doJoinConversation.call(that, _.extend(params, {
    //     onSuccess: that.doLaunchConversation.bind(that), // TODO
    //     conversation_id: conversation_id
    //   }));
    // // });
  },
  getConversationModel: function(conversation_id, suzinvite) {
    var model;
    if (window.preloadData && window.preloadData.conversation && !suzinvite) {
      model = new ConversationModel(preloadData);
      return Promise.resolve(model);
    }
    // no preloadData copy of the conversation model, so make an ajax request for it.
    return preloadHelper.firstConvPromise.then(function(conv) {
      model = new ConversationModel(conv);
      if (suzinvite) {
        model.set("suzinvite", suzinvite);
      }
      return model;
    });
  },

  redirect: function(path, ignoreEncodedParams) {
    var ep = (encodedParams ? ("/" + encodedParams) : "");
    if (ignoreEncodedParams) {
      ep = "";
    }
    document.location = document.location.protocol + "//" + document.location.host + path + ep;
  }

});

module.exports = polisRouter;
