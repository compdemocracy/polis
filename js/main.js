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


var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;

var forceEmbedded = false;

(function() {
  // auth token. keep this in this closure, don't put it on a global. used for cases where cookies are disabled.
  var token;

var p = window.location.pathname;
  // check for token within URL
  if (p.match(/^\/inbox\//) ||
      p.match(/^\/settings\//) ||
      p.match(/^\/conversation\/create\//) ||
      p.match(/^\/[0-9][A-Za-z0-9]+\/ep1_[A-Za-z0-9]+/)      
    ) {
    // expecting params (added to support LTI)
    var params = Utils.decodeParams(encodedParams);
    if (params.xPolisLti) {
      token = params.xPolisLti;
      window.authenticatedByHeader = true;
    }
    if (params.context) {
      window.context = params.context;
    }
    if (!_.isUndefined(params.forceEmbedded)) {
      forceEmbedded = !!params.forceEmbedded;
    }
  }



  $.ajaxPrefilter(function( options, originalOptions, jqXHR ) {
    if ( !options.beforeSend) {
      options.beforeSend = function (xhr) { 
        // TODO assert that ajax request is going to our servers (in case of XSS)
        if (token) {
          xhr.setRequestHeader('x-polis', token);
        }
      };
    }
  });
  $(document).ajaxSuccess(function( event, xhr, settings ) {
    var t = xhr.getResponseHeader('x-polis');
    if (t) {
      token = t;
    }
  });
}());

function ifDefined(context, options) {
  return "undefined" !== typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifDefined", ifDefined);

function ifNotDefined(context, options) {
  return "undefined" === typeof context ? options.fn(this) : "";
}
Handlebars.registerHelper("ifNotDefined", ifNotDefined);


function isEmbedded() {
  return (window.top != window) || forceEmbedded;
}

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

Handlebars.registerHelper('settings_href', function(arg0, options) {
  return "/settings" + (encodedParams ? ("/" + encodedParams) : "");
});

Handlebars.registerHelper('createConversationHref', function(arg0, options) {
  return "/conversation/create" + (encodedParams ? ("/" + encodedParams) : "");
});

Handlebars.registerHelper('inboxHref', function(arg0, options) {
  return "/inbox" + (encodedParams ? ("/" + encodedParams) : "");
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

function addProtocolToLinkIfNeeded(url) {
  if (url.match(/https?:\/\//)) {
    return url;
  } else {
    return "http://" + url;
  }
}

Handlebars.registerHelper('link', function(text, url) {
  text = Handlebars.Utils.escapeExpression(text);
  url  = Handlebars.Utils.escapeExpression(url);
  var result = '<a href="' + url + '">' + text + '</a>';

  return new Handlebars.SafeString(result);
});

Handlebars.registerHelper('linkExternal', function(text, url) {
  text = Handlebars.Utils.escapeExpression(text);
  url = addProtocolToLinkIfNeeded(url);
  url  = Handlebars.Utils.escapeExpression(url);
  var result = '<a href="' + url + '">' + text + '</a>';

  return new Handlebars.SafeString(result);
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

function isParticipationView() {
  return !!window.location.pathname.match(/^\/[0-9][A-Za-z0-9]+/);
}

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
    if (!isEmbedded() && !isParticipationView()) {
      // load intercom widget
      (function(){var w=window;var ic=w.Intercom;if(typeof ic==="function"){ic('reattach_activator');ic('update',intercomSettings);}else{var d=document;var i=function(){i.c(arguments)};i.q=[];i.c=function(args){i.q.push(args)};w.Intercom=i;function l(){var s=d.createElement('script');s.type='text/javascript';s.async=true;s.src='https://static.intercomcdn.com/intercom.v1.js';var x=d.getElementsByTagName('script')[0];x.parentNode.insertBefore(s,x);}if(w.attachEvent){w.attachEvent('onload',l);}else{w.addEventListener('load',l,false);}}})();
      
      IntercomModalHack.init();
    }


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

