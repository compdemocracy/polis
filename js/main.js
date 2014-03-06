var $ = require("jquery");
var eb = require("./eventBus");
var Backbone = require("backbone");
var RootView = require("./views/root");
var MainPolisRouter = require("./routers/main-polis-router");
var PolisStorage = require("./util/polisStorage");
var Handlebars = require("handlebars");
var _ = require("underscore");
var display = require("./util/display");

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


function ifDefined(context, options) {
  return "undefined" !== typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifDefined", ifDefined);

function ifEmbedded(arg0) {
  return window.top !== window ? arg0.fn(this) : "";
}
Handlebars.registerHelper("ifEmbedded", ifEmbedded);

function ifNotEmbedded(arg0) {
  return window.top === window ? arg0.fn(this) : "";
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
    return $.post("/v3/auth/deregister", {}).always(function() {
      window.location = "https://about.polis.io";
      // Backbone.history.navigate("/", {trigger: true});
    });
};

initialize(function(next) {
    // Load any data that your app requires to boot
    // and initialize all routers here, the callback
    // `next` is provided in case the operations
    // needed are aysynchronous
    var router = new MainPolisRouter();

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

function initialize(complete) {
    $(function() {
      Backbone.history.start({
        pushState: false,
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

