require([
  'jquery',
  'backbone',
  'views/root',
  'routers/main-polis-router',
  'bootstrap_alert',
  'bootstrap_tab',
  'bootstrap_tooltip',
  'bootstrap_button',
  'bootstrap_transition',
  // 'bootstrap_popover',
], function ($, Backbone, RootView, MainPolisRouter) {
  
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
        root: '/',
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

});
