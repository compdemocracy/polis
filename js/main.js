var $ = require("jquery");
var eb = require("./eventBus");
var Backbone = require("backbone");
var IntercomModalHack = require("./util/intercomModalHack");
var RootView = require("./views/root");
var MainPolisRouter = require("./routers/main-polis-router");
var Metrics = require("./metrics");
var PolisStorage = require("./util/polisStorage");
var Handlebars = require("handlebars");
var _ = require("underscore");
var display = require("./util/display");
var Utils = require("./util/utils");
var Url = require("./util/url");

// These are required here to ensure they are included in the build.
var bootstrapAlert = require("bootstrap_alert");
var bootstrapTab = require("bootstrap_tab");
var bootstrapToolTip = require("bootstrap_tooltip");
var bootstrapButton = require("bootstrap_button");
var bootstrapPopover = require("bootstrap_popover");
var bootstrapTransition = require("bootstrap_transition");
var bootstrapCollapse = require("bootstrap_collapse");
var bootstrapDropdown = require("bootstrap_dropdown");
var bootstrapAffix = require("bootstrap_affix");
var owl = require("owl");

// Call this here so it gets initialized early.
var popoverEach = require("./util/popoverEach");

// register partials
var HeaderPartial = require("./tmpl/header");
var BannerPartial = require("./tmpl/banner");
var BannerParticipantPaysPartial = require("./tmpl/banner_pp");
var TrialRemainingStatementPartial = require("./tmpl/trialRemainingStatement");
var FooterPartial = require("./tmpl/footer")

function ifDefined(context, options) {
  return "undefined" !== typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifDefined", ifDefined);

function ifNotDefined(context, options) {
  return "undefined" === typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifNotDefined", ifNotDefined);


function isEmbedded() {
  return window.top != window;
}

function ifEmbedded(arg0) {
  // NOTE != instead of !== for IE8
  return isEmbedded() ? arg0.fn(this) : "";
}
Handlebars.registerHelper("ifEmbedded", ifEmbedded);

function ifNotEmbedded(arg0) {
  // NOTE == instead of === for IE
  return window.top == window ? arg0.fn(this) : "";
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
  return isIE8()  ? "" : arg0.fn(this);
}
Handlebars.registerHelper("ifNotIE8", ifNotIE8);

function ifIos(arg0) {
  return Utils.isIos()  ? arg0.fn(this): "";
}
Handlebars.registerHelper("ifIos", ifIos);


// Handlebars.registerHelper("ifXs", function(arg0) {
//   return display.xs() ? arg0.fn(this) : "";
// });

// Handlebars.registerHelper("ifNotXs", function(arg0) {
//   return display.xs() ? "" : arg0.fn(this);
// });

function useCarousel(arg0) {
  return !isIE8() && display.xs();
}
Handlebars.registerHelper("useCarousel", function(arg0) {
  return useCarousel(arg0) ? arg0.fn(this) : "";
});
Handlebars.registerHelper("notUseCarousel", function(arg0) {
  return useCarousel(arg0) ? "" : arg0.fn(this);
});

Handlebars.registerHelper("ifAuthenticated", function(arg0) {
  return PolisStorage.uid() ? arg0.fn(this) : "";
});
Handlebars.registerHelper("ifNotAuthenticated", function(arg0) {
  return PolisStorage.uid() ? "" : arg0.fn(this);
});


Handlebars.registerHelper('logo_href', function(arg0, options) {
  // var shouldSeeInbox = PolisStorage.hasEmail();
  // return shouldSeeInbox ? "/inbox" : "/about";
  return "/about";
});


Handlebars.registerHelper("trialDaysRemaining", function(arg0, options) {
  return Utils.trialDaysRemaining();
});
Handlebars.registerHelper("ifTrial", function(arg0) {
  return Utils.isTrialUser() ? arg0.fn(this) : "";
});
Handlebars.registerHelper("ifIndividual", function(arg0) {
  return Utils.isIndividualUser() ? arg0.fn(this) : "";
});
Handlebars.registerHelper("ifStudent", function(arg0) {
  return Utils.isStudentUser() ? arg0.fn(this) : "";
});
Handlebars.registerHelper("ifParticipantPays", function(arg0) {
  return Utils.isPpUser() ? arg0.fn(this) : "";
});




// Partials
Handlebars.registerPartial("header", HeaderPartial);
Handlebars.registerPartial("banner", BannerPartial);
Handlebars.registerPartial("banner_pp", BannerParticipantPaysPartial);
Handlebars.registerPartial("trialRemainingStatement", TrialRemainingStatementPartial);
Handlebars.registerPartial("footer", FooterPartial);


_.mixin({
    isId: function(n) {
      return n >= 0;
    }
});

if (!window.location.hostname.match(/polis/)) {
    window.document.title = window.location.port;
}

// debug convenience function for deregistering.
window.deregister = function() {
    // relying on server to clear cookies
    return $.post("/api/v3/auth/deregister", {}).always(function() {
      window.location = "/about";
      // Backbone.history.navigate("/", {trigger: true});
    });
};

var uidPromise;
// if (PolisStorage.uidFromCookie()) {
//   uidPromise = $.Deferred().resolve(PolisStorage.uidFromCookie());
// } else {
  uidPromise = $.get("/api/v3/users").then(function(user) {
    window.userObject = $.extend(window.userObject, user);
  });
// }
uidPromise.always(function() {

  initialize(function(next) {
    // Load any data that your app requires to boot
    // and initialize all routers here, the callback
    // `next` is provided in case the operations
    // needed are aysynchronous
    var router = new MainPolisRouter();

    Metrics.boot();
    if (isEmbedded()) {
      setTimeout(function() {
        // Hide the Intercom help widget in participation view
        $("#IntercomDefaultWidget").hide();
      }, 1000);
    }

    IntercomModalHack.init();

    // set up the "exitConv" event
    var currentRoute;
    router.on("route", function(route, params) {
      console.log("route changed from: " + currentRoute+ " to: " + route);
      if (currentRoute === "conversationView") {
        eb.trigger(eb.exitConv);
      }
      currentRoute = route;
    });

    display.init();

    next();
  });

});


function initialize(complete) {
    $(function() {
      Backbone.history.start({
        pushState: true,
        root: "/",
        silent: true
    });

  // RootView may use link or url helpers which
  // depend on Backbone history being setup
  // so need to wait to loadUrl() (which will)
  // actually execute the route
  RootView.getInstance(document.body);

  complete(function() {
    Backbone.history.loadUrl();
  });
});
}

