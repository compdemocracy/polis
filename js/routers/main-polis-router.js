// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var $ = require("jquery");
var _ = require("underscore");
var Backbone = require("backbone");
var ConversationModel = require("../models/conversation");
var eb = require("../eventBus");
// var gaEvent = require("../util/gaMetric").gaEvent;
var metric = require("../util/gaMetric");
var ParticipantModel = require("../models/participant");
var ParticipationView = require("../views/participation");
var PolisStorage = require("../util/polisStorage");
var preloadHelper = require("../util/preloadHelper");
var RootView = require("../views/root");
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
  },
  participationViewWithQueryParams: function(conversation_id, queryParamString) {
    if (!Utils.cookiesEnabled()) {
      this.tryCookieThing();
    }
    var params = Utils.parseQueryParams(queryParamString);
    this.doLaunchConversation2(conversation_id, params);
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
