// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var $ = require("jquery");
var _ = require("lodash");
var Backbone = require("backbone");
var ConversationModel = require("../models/conversation");
var eb = require("../eventBus");
var metric = require("../util/gaMetric");
var ParticipantModel = require("../models/participant");
var ParticipationView = require("../views/participation");
var PolisStorage = require("../util/polisStorage");
var preloadHelper = require("../util/preloadHelper");
var RootView = require("../views/root");
var Constants = require("../util/constants");
var Utils = require("../util/utils");

var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;

var authenticatedDfd = $.Deferred();
authenticatedDfd.done(function () {
  // link uid to GA user_id
  // TODO update this whenever auth changes
  if (Constants.GA_TRACKING_ID) {
    const userId = PolisStorage.uid();
    gtag("set", "user_properties", { user_id: userId });
  }
});

function onFirstRender() {
  $("#mainSpinner").hide();
}

function authenticated() {
  // Check for JWT token first
  var jwtToken = PolisStorage.getJwtToken();
  if (jwtToken) {
    return true;
  }

  // Fallback to other auth methods (e.g., preloaded user data)
  var uid = PolisStorage.uid();

  var isAuthenticated = uid;
  return isAuthenticated;
}

var polisRouter = Backbone.Router.extend({
  gotoRoute: function (route) {
    window.location = route;
  },

  initialize: function () {
    this.r(/^([0-9][0-9A-Za-z]+)\/?(\?.*)?$/, "participationViewWithQueryParams"); // conversation_id / query params
    this.r(/^([0-9][0-9A-Za-z]+)(\/ep1_[0-9A-Za-z]+)?$/, "participationView"); // conversation_id / encodedStringifiedJson
    this.r(/^ot\/([0-9][0-9A-Za-z]+)\/(.*)/, "participationViewWithSuzinvite"); // ot/conversation_id/suzinvite
    this.r(/^demo\/([0-9][0-9A-Za-z]+)/, "demoConversation");

    eb.once(eb.firstRender, function () {
      onFirstRender();
    });

    var authStatus = authenticated();
    if (authStatus) {
      authenticatedDfd.resolve();
    } else {
      console.warn("[Router] User not authenticated during initialization");
    }
  }, // end initialize

  r(pattern, methodNameToCall) {
    this.route(pattern, (...args) => {
      metric.routeEvent(methodNameToCall, args);
      this[methodNameToCall].apply(this, args);
    });
  },

  bail: function () {
    this.gotoRoute("/", {
      trigger: true
    });
  },

  doLaunchConversation2: function (conversation_id, args) {
    // Since nextComment is pretty slow, fire off the request way early (this actually happens on the js on index.html now) and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = preloadHelper.firstCommentPromise;

    this.getConversationModel(conversation_id).then(
      function (model) {
        if (!_.isUndefined(args.vis_type)) {
          // allow turning on the vis from the URL.
          if (model.get("is_mod")) {
            model.set("vis_type", Number(args.vis_type));
          }
        }

        var participationView = new ParticipationView({
          wipCommentFormText: args.wipCommentFormText,
          model: model,
          finishedTutorial: window.userObject && window.userObject.finishedTutorial,
          firstCommentPromise: firstCommentPromise
        });
        RootView.getInstance().setView(participationView);
      },
      function (e) {
        console.error("[Router] Error loading conversation model:", e);
      }
    );
  },

  doLaunchConversation: function (args) {
    var ptptModel = args.ptptModel;
    var conversation_id = ptptModel.get("conversation_id");

    // Since nextComment is pretty slow, fire off the request way early and pass the promise into the participation view so it's (probably) ready when the page loads.
    var firstCommentPromise = $.get(
      "/api/v3/nextComment?not_voted_by_pid=-1&limit=1&conversation_id=" + conversation_id
    );

    this.getConversationModel(conversation_id).then(
      function (model) {
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
          finishedTutorial: window.userObject && window.userObject.finishedTutorial,
          firstCommentPromise: firstCommentPromise
        });
        RootView.getInstance().setView(participationView);
      },
      function (e) {
        console.error("[Router] Error loading conversation model in doLaunchConversation:", e);
      }
    );
  },

  demoConversation: function (conversation_id) {
    var ptpt = new ParticipantModel({
      conversation_id: conversation_id,
      pid: -123 // DEMO_MODE
    });

    // NOTE: not posting the model

    this.doLaunchConversation({
      ptptModel: ptpt
    });
  },

  participationViewWithSuzinvite: function (conversation_id, suzinvite) {
    window.suzinvite = suzinvite;
    return this.participationView(conversation_id, null, suzinvite);
  },

  participationView: function (conversation_id, encodedStringifiedJson) {
    var params = {};
    if (encodedStringifiedJson) {
      encodedStringifiedJson = encodedStringifiedJson.slice(1);
      try {
        params = Utils.decodeParams(encodedStringifiedJson);
      } catch (e) {
        console.error("[Router] Error decoding params:", e);
      }
    }
    this.doLaunchConversation2(conversation_id, params);
  },

  participationViewWithQueryParams: function (conversation_id, queryParamString) {
    var params = {};
    try {
      params = Utils.parseQueryParams(queryParamString);
    } catch (e) {
      console.error("[Router] Error parsing query params:", e);
    }
    this.doLaunchConversation2(conversation_id, params);
  },

  getConversationModel: function (conversation_id, suzinvite) {
    var model;
    if (window.preloadData && window.preloadData.conversation && !suzinvite) {
      model = new ConversationModel(window.preloadData);
      return Promise.resolve(model);
    }
    // no preloadData copy of the conversation model, so make an ajax request for it.
    return preloadHelper.firstConvPromise
      .then(function (conv) {
        model = new ConversationModel(conv);
        if (suzinvite) {
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
    var ep = encodedParams ? "/" + encodedParams : "";
    if (ignoreEncodedParams) {
      ep = "";
    }
    var finalUrl = document.location.protocol + "//" + document.location.host + path + ep;
    document.location = finalUrl;
  }
});

module.exports = polisRouter;
