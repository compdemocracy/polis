// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var $ = require("jquery");
var _ = require("lodash");
var Backbone = require("backbone");
var bbFetch = require("../net/bbFetch");
var ConversationModel = require("../models/conversation");
var eb = require("../eventBus");
var metric = require("../util/gaMetric");
var ParticipantModel = require("../models/participant");
var ParticipationView = require("../views/participation");
var PolisStorage = require("../util/polisStorage");
var preloadHelper = require("../util/preloadHelper");
var RootView = require("../views/root");
var Constants = require("../util/constants");
var SettingsView = require("../views/settings.js");
var UserModel = require("../models/user");
var Utils = require("../util/utils");
var hasEmail = require("../util/polisStorage").hasEmail;

var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;

console.log("[Router] Initializing router with encodedParams:", encodedParams);

var authenticatedDfd = $.Deferred();
authenticatedDfd.done(function () {
  console.log("[Router] Authentication deferred resolved");
  // link uid to GA user_id
  // TODO update this whenever auth changes
  if (Constants.GA_TRACKING_ID) {
    const userId = PolisStorage.uid();
    console.log("[Router] Setting GA user_id:", userId);
    gtag("set", "user_properties", { user_id: userId });
  }
});

function onFirstRender() {
  console.log("[Router] First render completed, hiding spinner");
  $("#mainSpinner").hide();
}

function authenticated() {
  console.log("[Router] authenticated() called");

  // Check for JWT token first
  var jwtToken = PolisStorage.getJwtToken();
  console.log("[Router] JWT token check:", jwtToken ? "present" : "not present");
  if (jwtToken) {
    console.log("[Router] User authenticated via JWT");
    return true;
  }

  // Fallback to other auth methods (e.g., preloaded user data)
  var uid = PolisStorage.uid();
  var headerAuth = window.authenticatedByHeader;
  console.log("[Router] Fallback auth check - uid:", uid, "headerAuth:", headerAuth);

  var isAuthenticated = uid || headerAuth;
  console.log("[Router] Final authentication result:", isAuthenticated);
  return isAuthenticated;
}

var polisRouter = Backbone.Router.extend({
  gotoRoute: function (route, options) {
    console.log("[Router] gotoRoute called:", route, options);
    // this.navigate(route, options);
    window.location = route;
  },
  initialize: function (options) {
    console.log("[Router] Router initialize called with options:", options);

    this.r(/^conversation\/create(\/ep1_[0-9A-Za-z]+)?/, "createConversation");
    this.r("user/create(/:params)", "createUser");
    this.r(/^user\/logout(\/.+)/, "deregister");
    this.r("welcome/:einvite", "createUserViewFromEinvite");
    this.r("", "landingPageView");

    this.r(/^([0-9][0-9A-Za-z]+)\/?(\?.*)?$/, "participationViewWithQueryParams"); // conversation_id / query params
    this.r(/^([0-9][0-9A-Za-z]+)(\/ep1_[0-9A-Za-z]+)?$/, "participationView"); // conversation_id / encodedStringifiedJson
    this.r(/^ot\/([0-9][0-9A-Za-z]+)\/(.*)/, "participationViewWithSuzinvite"); // ot/conversation_id/suzinvite
    this.r(/^demo\/([0-9][0-9A-Za-z]+)/, "demoConversation");

    this.r(/^settings(\/ep1_[0-9A-Za-z]+)?/, "settings");

    //this.r(/^summary\/([0-9][0-9A-Za-z]+)$/, "summaryView");  // summary/conversation_id

    this.on("route", function (route, params) {
      console.log("[Router] Route event fired:", route, "params:", params);
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
    eb.once(eb.firstRender, function () {
      console.log("[Router] First render event received");
      onFirstRender();
    });

    var authStatus = authenticated();
    console.log("[Router] Initial authentication status:", authStatus);
    if (authStatus) {
      console.log("[Router] Resolving authentication deferred");
      authenticatedDfd.resolve();
    } else {
      console.log("[Router] User not authenticated during initialization");
    }
  }, // end initialize
  r(pattern, methodNameToCall) {
    console.log("[Router] Registering route:", pattern, "->", methodNameToCall);
    this.route(pattern, (...args) => {
      console.log("[Router] Route matched:", methodNameToCall, "args:", args);
      metric.routeEvent(methodNameToCall, args);
      this[methodNameToCall].apply(this, args);
    });
  },
  bail: function () {
    console.log("[Router] bail() called");
    this.gotoRoute("/", {
      trigger: true
    });
  },

  landingPageView: function () {
    console.log("[Router] landingPageView() called");
    var authStatus = authenticated();
    console.log("[Router] Authentication status for landing page:", authStatus);
    if (!authStatus) {
      console.log("[Router] User not authenticated, redirecting to user creation");
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
      console.log("[Router] User authenticated, redirecting to inbox");
      // this.inbox();
      this.gotoRoute("/inbox", {
        trigger: true
      });
    }
  },

  settings: function (encodedStringifiedJson) {
    console.log("[Router] settings() called with params:", encodedStringifiedJson);
    var promise = $.Deferred().resolve();
    var authStatus = authenticated();
    var emailStatus = hasEmail();
    console.log("[Router] Settings auth status:", authStatus, "email status:", emailStatus);

    if (!authStatus) {
      console.log("[Router] User not authenticated, initiating login");
      promise = this.doLogin(false);
    } else if (!emailStatus && !window.authenticatedByHeader) {
      console.log("[Router] User authenticated but no email, requiring login");
      promise = this.doLogin(true);
    }
    promise
      .then(function () {
        console.log("[Router] Loading user model for settings");
        var userModel = new UserModel();
        bbFetch(userModel)
          .then(function () {
            console.log("[Router] User model loaded, creating settings view");
            var v = new SettingsView({
              model: userModel
            });
            RootView.getInstance().setView(v);
          })
          .fail(function (error) {
            console.error("[Router] Error loading user model:", error);
          });
      })
      .fail(function (error) {
        console.error("[Router] Error in settings promise chain:", error);
      });
  },

  deregister: function (dest) {
    console.log("[Router] deregister() called with destination:", dest);
    window.deregister(dest);
  },

  doLaunchConversation2: function (conversation_id, args) {
    console.log("[Router] doLaunchConversation2() called with conversation_id:", conversation_id, "args:", args);

    // Since nextComment is pretty slow, fire off the request way early (this actually happens on the js on index.html now) and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = preloadHelper.firstCommentPromise;
    console.log("[Router] Using preloaded firstCommentPromise:", firstCommentPromise);

    this.getConversationModel(conversation_id).then(
      function (model) {
        console.log("[Router] Conversation model loaded:", model.toJSON ? model.toJSON() : model);

        if (!_.isUndefined(args.vis_type)) {
          console.log("[Router] Setting vis_type:", args.vis_type);
          // allow turning on the vis from the URL.
          if (model.get("is_mod")) {
            model.set("vis_type", Number(args.vis_type));
          }
        }

        console.log("[Router] Creating ParticipationView");
        var participationView = new ParticipationView({
          wipCommentFormText: args.wipCommentFormText,
          model: model,
          finishedTutorial: window.userObject && window.userObject.finishedTutorial,
          firstCommentPromise: firstCommentPromise
        });
        console.log("[Router] Setting ParticipationView as root view");
        RootView.getInstance().setView(participationView);
      },
      function (e) {
        console.error("[Router] Error loading conversation model:", e);
      }
    );
  },

  doLaunchConversation: function (args) {
    console.log("[Router] doLaunchConversation() called with args:", args);
    var ptptModel = args.ptptModel;
    var conversation_id = ptptModel.get("conversation_id");
    console.log("[Router] Extracted conversation_id from participant model:", conversation_id);

    // Since nextComment is pretty slow, fire off the request way early and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = $.get(
      "/api/v3/nextComment?not_voted_by_pid=-1&limit=1&conversation_id=" + conversation_id
    );
    console.log("[Router] Created firstCommentPromise for conversation:", conversation_id);

    this.getConversationModel(conversation_id).then(
      function (model) {
        console.log(
          "[Router] Conversation model loaded for doLaunchConversation:",
          model.toJSON ? model.toJSON() : model
        );

        if (!_.isUndefined(args.vis_type)) {
          console.log("[Router] Setting vis_type from args:", args.vis_type);
          // allow turning on the vis from the URL.
          if (model.get("is_mod")) {
            model.set("vis_type", Number(args.vis_type));
          }
        }

        console.log("[Router] Creating ParticipationView with participant model");
        var participationView = new ParticipationView({
          wipCommentFormText: args.wipCommentFormText,
          model: model,
          ptptModel: ptptModel,
          finishedTutorial: window.userObject && window.userObject.finishedTutorial,
          firstCommentPromise: firstCommentPromise
        });
        console.log("[Router] Setting ParticipationView as root view");
        RootView.getInstance().setView(participationView);
      },
      function (e) {
        console.error("[Router] Error loading conversation model in doLaunchConversation:", e);
      }
    );
  },

  demoConversation: function (conversation_id) {
    console.log("[Router] demoConversation() called with conversation_id:", conversation_id);
    var ptpt = new ParticipantModel({
      conversation_id: conversation_id,
      pid: -123 // DEMO_MODE
    });
    console.log("[Router] Created demo participant model:", ptpt.toJSON ? ptpt.toJSON() : ptpt);

    // NOTE: not posting the model

    this.doLaunchConversation({
      ptptModel: ptpt
    });
  },

  participationViewWithSuzinvite: function (conversation_id, suzinvite) {
    console.log(
      "[Router] participationViewWithSuzinvite() called with conversation_id:",
      conversation_id,
      "suzinvite:",
      suzinvite
    );
    window.suzinvite = suzinvite;
    return this.participationView(conversation_id, null, suzinvite);
  },

  participationView: function (conversation_id, encodedStringifiedJson, suzinvite) {
    console.log(
      "[Router] participationView() called with conversation_id:",
      conversation_id,
      "encoded params:",
      encodedStringifiedJson,
      "suzinvite:",
      suzinvite
    );
    var params = {};
    if (encodedStringifiedJson) {
      encodedStringifiedJson = encodedStringifiedJson.slice(1);
      try {
        params = Utils.decodeParams(encodedStringifiedJson);
        console.log("[Router] Decoded params:", params);
      } catch (e) {
        console.error("[Router] Error decoding params:", e);
      }
    }
    this.doLaunchConversation2(conversation_id, params);
  },

  participationViewWithQueryParams: function (conversation_id, queryParamString) {
    console.log(
      "[Router] participationViewWithQueryParams() called with conversation_id:",
      conversation_id,
      "query params:",
      queryParamString
    );
    var params = {};
    try {
      params = Utils.parseQueryParams(queryParamString);
      console.log("[Router] Parsed query params:", params);
    } catch (e) {
      console.error("[Router] Error parsing query params:", e);
    }
    this.doLaunchConversation2(conversation_id, params);
  },

  getConversationModel: function (conversation_id, suzinvite) {
    console.log(
      "[Router] getConversationModel() called with conversation_id:",
      conversation_id,
      "suzinvite:",
      suzinvite
    );
    var model;
    if (window.preloadData && window.preloadData.conversation && !suzinvite) {
      console.log("[Router] Using preloaded conversation data:", window.preloadData);
      model = new ConversationModel(window.preloadData);
      return Promise.resolve(model);
    }
    // no preloadData copy of the conversation model, so make an ajax request for it.
    console.log("[Router] No preloaded conversation data, using firstConvPromise");
    return preloadHelper.firstConvPromise
      .then(function (conv) {
        console.log("[Router] firstConvPromise resolved with:", conv);
        model = new ConversationModel(conv);
        if (suzinvite) {
          console.log("[Router] Setting suzinvite on model:", suzinvite);
          model.set("suzinvite", suzinvite);
        }
        return model;
      })
      .fail(function (error) {
        console.error("[Router] Error in firstConvPromise:", error);
        throw error;
      });
  },

  redirect: function (path, ignoreEncodedParams) {
    console.log("[Router] redirect() called with path:", path, "ignoreEncodedParams:", ignoreEncodedParams);
    var ep = encodedParams ? "/" + encodedParams : "";
    if (ignoreEncodedParams) {
      ep = "";
    }
    var finalUrl = document.location.protocol + "//" + document.location.host + path + ep;
    console.log("[Router] Redirecting to:", finalUrl);
    document.location = finalUrl;
  }
});

module.exports = polisRouter;
