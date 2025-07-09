// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// init this asap
var preloadHelper = require("./util/preloadHelper");

var $ = require("jquery");
var _ = require("lodash");

require("../vis2/vis2"); // This is to initialise the 'window' object
var Backbone = require("backbone");
require("./net/backbonePolis"); // Monkeypatch Backbone
var CurrentUserModel = require("./stores/currentUser");
var display = require("./util/display");
var eb = require("./eventBus");
var Handlebars = require("handlebars");
var MainPolisRouter = require("./routers/main-polis-router");
var PolisStorage = require("./util/polisStorage");
var PostMessageUtils = require("./util/postMessageUtils");
var RootView = require("./views/root");
var Utils = require("./util/utils");

console.log("[Main] Core modules loaded");

// These are required here to ensure they are included in the build.
require("bootstrap-sass/assets/javascripts/bootstrap/affix");
require("bootstrap-sass/assets/javascripts/bootstrap/alert");
require("bootstrap-sass/assets/javascripts/bootstrap/button");
require("bootstrap-sass/assets/javascripts/bootstrap/collapse");
require("bootstrap-sass/assets/javascripts/bootstrap/dropdown");
require("bootstrap-sass/assets/javascripts/bootstrap/popover");
require("bootstrap-sass/assets/javascripts/bootstrap/tab");
require("bootstrap-sass/assets/javascripts/bootstrap/tooltip");
require("bootstrap-sass/assets/javascripts/bootstrap/transition");
require("./util/popoverEach");

console.log("[Main] Bootstrap components loaded");

// register partials
var FooterPartial = require("./templates/footer.handlebars");
var HeaderPartial = require("./templates/header.handlebars");
var HeaderWhatisPolisPartial = require("./templates/headerWhatIsPolis.handlebars");
var LinkAddPolisPartial = require("./templates/link-AddPolis-partial.handlebars");
var LinkPrivacyPartial = require("./templates/link-privacy-partial.handlebars");
var LinkTosPartial = require("./templates/link-TOS-partial.handlebars");
var PolisLogoPartial = require("./templates/polisLogo.handlebars");

//  require icon partials
var IconFaAngleLeft = require("./templates/icon_fa_angle_left.handlebars");
var IconFaAngleRight = require("./templates/icon_fa_angle_right.handlebars");
var IconFaAsterisk = require("./templates/icon_fa_asterisk.handlebars");
var IconFaBan = require("./templates/icon_fa_ban.handlebars");
var IconFaCircleCheckPartial = require("./templates/icon_fa_check_circle.handlebars");
var IconFaCircleQuestion = require("./templates/icon_fa_question_circle.handlebars");
var IconFaLightBulb = require("./templates/icon_fa_lightbulb_o.handlebars");
var IconFaTimes = require("./templates/icon_fa_times.handlebars");

// require logo partials
var Logo = require("./templates/logo.handlebars");
var LogoInvert = require("./templates/logo_invert.handlebars");

console.log("[Main] Templates loaded");

var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;
var forceEmbedded = false;

console.log("[Main] URL analysis - pathname:", window.location.pathname, "encodedParams:", encodedParams);

// notify parent iframe when document changes height

function getHeight() {
  var DOCUMENT_HEIGHT_FUDGE_FACTOR = 10; // prevent scrollbar, not sure why it's not correct without this.
  return $(document.body).outerHeight() + DOCUMENT_HEIGHT_FUDGE_FACTOR;
}
var oldDocumentHeight = getHeight();
if (isEmbedded()) {
  console.log("[Main] App is embedded, setting up height monitoring");
  setInterval(function () {
    var nu = getHeight();
    if (nu !== oldDocumentHeight) {
      oldDocumentHeight = nu;
      PostMessageUtils.postResizeEvent(nu);
    }
  }, 200);
} else {
  console.log("[Main] App is not embedded");
}

function stripParams(paramsToStrip) {
  console.log("[Main] stripParams called with:", paramsToStrip);
  var params = Utils.decodeParams(encodedParams);
  var remainingParams = _.omit(params, paramsToStrip);
  var newEncodedParams = Utils.encodeParams(remainingParams);
  // don't redirect there, just change the current url in case of subsequent reload
  var path = document.location.pathname.match(/^((?!ep1_).)*/)[0];
  if (newEncodedParams) {
    newEncodedParams = "/" + newEncodedParams;
  }
  window.history.pushState("", "", path + newEncodedParams);
  // clobber the variable so we don't accidentally use it again
  encodedParams = newEncodedParams;
  console.log("[Main] URL updated to:", window.location.href);
}

// remove wipCommentFormText after we've loaded it into the view.
eb.on(eb.doneUsingWipCommentFormText, function () {
  console.log("[Main] Event: doneUsingWipCommentFormText");
  stripParams(["wipCommentFormText"]);
});

eb.on(eb.reload, function (params) {
  console.log("[Main] Event: reload with params:", params);
  location.reload();
});

eb.on(eb.reloadWithMoreParams, function (params) {
  console.log("[Main] Event: reloadWithMoreParams with params:", params);
  var existingParams = encodedParams ? Utils.decodeParams(encodedParams) : {};
  var combinedParams = _.extend({}, existingParams, params);
  var ep = Utils.encodeParams(combinedParams);
  if (!combinedParams || 0 === _.keys(combinedParams).length) {
    ep = "";
  }
  var path = document.location.pathname.match(/^((?!ep1_).)*/)[0];
  if (path[path.length - 1] === "/") {
    path = path.slice(0, path.length - 1);
  }
  document.location = document.location.protocol + "//" + document.location.host + path + "/" + ep;
});

(function () {
  console.log("[Main] Setting up AJAX prefilter and success handler");
  var p = window.location.pathname;
  console.log("[Main] Current pathname:", p);
  // check for token within URL
  if (
    p.match(/^\/inbox\//) ||
    p.match(/^\/settings\/ep1_[A-Za-z0-9]+/) ||
    p.match(/^\/conversation\/create\//) ||
    p.match(/^\/[0-9][A-Za-z0-9]+\/ep1_[A-Za-z0-9]+/)
  ) {
    console.log("[Main] URL matches special pattern, processing params");
    var params = Utils.decodeParams(encodedParams);
    console.log("[Main] Decoded params:", params);
    if (params.context) {
      window.context = params.context;
      console.log("[Main] Set window.context:", window.context);
    }
    if (!_.isUndefined(params.forceEmbedded)) {
      forceEmbedded = !!params.forceEmbedded;
      console.log("[Main] Set forceEmbedded:", forceEmbedded);
    }
  }

  $.ajaxPrefilter(function (options) {
    console.log("[Main] AJAX prefilter - URL:", options.url);
    if (!options.beforeSend) {
      options.beforeSend = function (xhr) {
        // Add JWT token to Authorization header if available
        var jwtToken = PolisStorage.getJwtToken();
        if (jwtToken) {
          console.log("[Main] Adding JWT token to AJAX request");
          xhr.setRequestHeader("Authorization", "Bearer " + jwtToken);
        } else {
          console.log("[Main] No JWT token available for AJAX request");
        }
      };
    }
  });

  // Listen for JWT tokens in response and store them
  $(document).ajaxSuccess(function (event, xhr, settings) {
    console.log("[Main] AJAX success for URL:", settings.url);
    try {
      var responseText = xhr.responseText;
      if (responseText) {
        var response = JSON.parse(responseText);
        // Check if response contains a JWT token in auth field
        if (response && response.auth && response.auth.token) {
          console.log("[Main] JWT token received in AJAX response, storing");
          PolisStorage.setJwtToken(response.auth.token);
        }
      }
    } catch {
      console.log("[Main] AJAX response not JSON or no auth field");
    }
  });
})();

function ifDefined(context, options) {
  return "undefined" !== typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifDefined", ifDefined);

function ifNotDefined(context, options) {
  return "undefined" === typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifNotDefined", ifNotDefined);

function isEmbedded() {
  return window.top != window || forceEmbedded;
}
window.isEmbedded = isEmbedded;

function ifEmbedded(arg0) {
  // NOTE != instead of !== for IE8
  return isEmbedded() ? arg0.fn(this) : "";
}
Handlebars.registerHelper("ifEmbedded", ifEmbedded);

function ifNotEmbedded(arg0) {
  // NOTE == instead of === for IE
  return isEmbedded() ? "" : arg0.fn(this);
}
Handlebars.registerHelper("ifNotEmbedded", ifNotEmbedded);

function isIE8() {
  return /MSIE 8.0/.exec(navigator.userAgent);
}

function ifIE8(arg0) {
  return isIE8() ? arg0.fn(this) : "";
}
Handlebars.registerHelper("ifIE8", ifIE8);

function ifNotIE8(arg0) {
  return isIE8() ? "" : arg0.fn(this);
}
Handlebars.registerHelper("ifNotIE8", ifNotIE8);

function ifIos(arg0) {
  return Utils.isIos() ? arg0.fn(this) : "";
}
Handlebars.registerHelper("ifIos", ifIos);

Handlebars.registerHelper("ifXs", function (arg0) {
  return display.xs() ? arg0.fn(this) : "";
});

Handlebars.registerHelper("ifNotXs", function (arg0) {
  return display.xs() ? "" : arg0.fn(this);
});

function useCarousel() {
  return !isIE8() && display.xs();
}
Handlebars.registerHelper("useCarousel", function (arg0) {
  return useCarousel(arg0) ? arg0.fn(this) : "";
});
Handlebars.registerHelper("notUseCarousel", function (arg0) {
  return useCarousel(arg0) ? "" : arg0.fn(this);
});

Handlebars.registerHelper("ifAuthenticated", function (arg0) {
  var authenticated = PolisStorage.uid();
  console.log("[Main] Handlebars ifAuthenticated check:", authenticated);
  return authenticated ? arg0.fn(this) : "";
});
Handlebars.registerHelper("ifNotAuthenticated", function (arg0) {
  var authenticated = PolisStorage.uid();
  console.log("[Main] Handlebars ifNotAuthenticated check:", authenticated);
  return authenticated ? "" : arg0.fn(this);
});

Handlebars.registerHelper("logo_href", function () {
  // var shouldSeeInbox = PolisStorage.hasEmail();
  // return shouldSeeInbox ? "/inbox" : "/about";
  return "/about";
});

Handlebars.registerHelper("settings_href", function () {
  return "/settings" + (encodedParams ? "/" + encodedParams : "");
});

Handlebars.registerHelper("createConversationHref", function () {
  return "/conversation/create" + (encodedParams ? "/" + encodedParams : "");
});
Handlebars.registerHelper("whatIsPolisHref", function () {
  return "/about";
});

Handlebars.registerHelper("inboxHref", function () {
  return "/inbox" + (encodedParams ? "/" + encodedParams : "");
});

Handlebars.registerHelper("ifDebugCommentProjection", function (arg0) {
  return Utils.debugCommentProjection ? arg0.fn(this) : "";
});

function addProtocolToLinkIfNeeded(url) {
  if (!url) {
    return url;
  } else if (url.match(/https?:\/\//)) {
    return url;
  } else {
    return "http://" + url;
  }
}

Handlebars.registerHelper("link", function (text, url) {
  text = Handlebars.Utils.escapeExpression(text);
  url = Handlebars.Utils.escapeExpression(url);
  var result = '<a href="' + url + '">' + text + "</a>";

  return new Handlebars.SafeString(result);
});

Handlebars.registerHelper("linkExternal", function (text, url) {
  text = Handlebars.Utils.escapeExpression(text);
  url = addProtocolToLinkIfNeeded(url);
  url = Handlebars.Utils.escapeExpression(url);
  var result =
    '<a style="color:black" href="' +
    url +
    '" target="_blank">' +
    text +
    ' &nbsp;<i class="fa fa-external-link" style="font-size: 0.7em;"></i></a>';

  return new Handlebars.SafeString(result);
});

// Partials
Handlebars.registerPartial("polisLogo", PolisLogoPartial);
Handlebars.registerPartial("header", HeaderPartial);
Handlebars.registerPartial("headerWhatIsPolis", HeaderWhatisPolisPartial);
Handlebars.registerPartial("footer", FooterPartial);
Handlebars.registerPartial("linkTos", LinkTosPartial);
Handlebars.registerPartial("linkPrivacy", LinkPrivacyPartial);
Handlebars.registerPartial("linkAddPolis", LinkAddPolisPartial);
Handlebars.registerPartial("iconFaCircleCheck", IconFaCircleCheckPartial);
Handlebars.registerPartial("iconFaCircleQuestion", IconFaCircleQuestion);
Handlebars.registerPartial("iconFaBan", IconFaBan);
Handlebars.registerPartial("iconFaLightBulb", IconFaLightBulb);
Handlebars.registerPartial("iconFaAsterisk", IconFaAsterisk);
Handlebars.registerPartial("iconFaTimes", IconFaTimes);
Handlebars.registerPartial("iconFaAngleLeft", IconFaAngleLeft);
Handlebars.registerPartial("iconFaAngleRight", IconFaAngleRight);
Handlebars.registerPartial("logoInvert", LogoInvert);
Handlebars.registerPartial("logo", Logo);

if (!window.location.hostname.match(/polis/)) {
  window.document.title = window.location.port;
}

// debug convenience function for deregistering.
window.deregister = function (dest) {
  console.log("[Main] deregister() called with destination:", dest);
  // Clear JWT token on logout
  if (PolisStorage && PolisStorage.clearJwtToken) {
    PolisStorage.clearJwtToken();
  }

  // Make logout request to server
  return $.post("/api/v3/auth/deregister", {}).always(function () {
    console.log("[Main] Logout request completed, redirecting");
    window.location = dest || "/about";
    // Backbone.history.navigate("/", {trigger: true});
  });
};

console.log("[Main] Global functions defined");

var uidPromise;
// Initialize user state - remove cookie fallback since we're JWT-only now
console.log("[Main] Initializing CurrentUserModel");
uidPromise = CurrentUserModel.update();

console.log("[Main] Checking preload promises");
console.log("[Main] preloadHelper.firstConvPromise:", preloadHelper.firstConvPromise);
console.log("[Main] preloadHelper.acceptLanguagePromise:", preloadHelper.acceptLanguagePromise);

preloadHelper.firstConvPromise.then(
  function (data) {
    console.log("[Main] firstConvPromise resolved successfully with:", data);
    PostMessageUtils.postInitEvent("ok");
  },
  function (error) {
    console.error("[Main] firstConvPromise rejected with error:", error);
    PostMessageUtils.postInitEvent("error");
  }
);

$.when(preloadHelper.acceptLanguagePromise, uidPromise).always(function () {
  console.log("[Main] Both acceptLanguagePromise and uidPromise completed");
  console.log("[Main] Arguments:", arguments);

  initialize(function (next) {
    console.log("[Main] initialize() callback called");
    // Load any data that your app requires to boot
    // and initialize all routers here, the callback
    // `next` is provided in case the operations
    // needed are aysynchronous
    console.log("[Main] Creating MainPolisRouter");
    var router = new MainPolisRouter();

    // set up the "exitConv" event
    var currentRoute;
    router.on("route", function (route, params) {
      console.log("[Main] Router route changed from:", currentRoute, "to:", route, "params:", params);
      if (currentRoute === "conversationView") {
        console.log("[Main] Triggering exitConv event");
        eb.trigger(eb.exitConv);
      }
      currentRoute = route;
    });

    console.log("[Main] Initializing display");
    display.init();

    console.log("[Main] Calling next() to proceed with initialization");
    next();
  });
});

function initialize(complete) {
  console.log("[Main] initialize() called");
  $(function () {
    console.log("[Main] DOM ready, starting Backbone history");
    Backbone.history.start({
      pushState: true,
      root: "/",
      silent: true
    });
    console.log("[Main] Backbone history started");

    // RootView may use link or url helpers which
    // depend on Backbone history being setup
    // so need to wait to loadUrl() (which will)
    // actually execute the route
    console.log("[Main] Creating RootView instance");
    RootView.getInstance(document.body);

    console.log("[Main] Calling complete callback");
    complete(() => {
      console.log("[Main] Loading initial URL via Backbone history");
      Backbone.history.loadUrl();
      console.log("[Main] Initial URL loaded");
    });
  });
}
