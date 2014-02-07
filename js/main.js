var $ = require("jquery");
var Backbone = require("backbone");
var RootView = require("./views/root");
var MainPolisRouter = require("./routers/main-polis-router");
var PolisStorage = require("./util/polisStorage");

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
    return $.post("/v3/auth/deregister", {}).always(function() {
      // relying on server to clear cookies
      Backbone.history.navigate("/", {trigger: true});
    });
};

initialize(function(next) {
    // Load any data that your app requires to boot
    // and initialize all routers here, the callback
    // `next` is provided in case the operations
    // needed are aysynchronous
    new MainPolisRouter();

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

