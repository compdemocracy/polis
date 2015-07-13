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
var HeaderWhatisPolisPartial = require("./tmpl/headerWhatIsPolis");
var BannerPartial = require("./tmpl/banner");
var BannerParticipantPaysPartial = require("./tmpl/banner_pp");
var TrialRemainingStatementPartial = require("./tmpl/trialRemainingStatement");
var FooterPartial = require("./tmpl/footer");
var PolisLogoPartial = require("./tmpl/polisLogo");
var TutorialSlidesButtonsPartial = require("./tmpl/tutorialSlidesButtonsPartial");
var TutorialSlidesButtonsLeftPartial = require("./tmpl/tutorialSlidesButtonsLeftPartial");


var LinkTosPartial = require("./tmpl/link-TOS-partial")
var LinkPrivacyPartial = require("./tmpl/link-privacy-partial")
var LinkAddPolisPartial = require("./tmpl/link-AddPolis-partial")


var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;

var forceEmbedded = false;

// notify parent iframe when document changes height
function getPolisFrameId() {
  if (window.location.search) {
    var params = Utils.parseQueryParams(window.location.search);
    if (params.site_id && params.page_id) {
      return [params.site_id, params.page_id].join("_");
    }
  }
  var parts = window.location.pathname.split("/");
  if (parts && parts.length > 1) {
    // first element is emptystring, since path starts with a "/""
    parts = parts.slice(1);
  } else {
    return "error2384";
  }
  return parts.join("_");
}
function getHeight() {
  var DOCUMENT_HEIGHT_FUDGE_FACTOR = 10; // prevent scrollbar, not sure why it's not correct without this.
  return $(document.body).outerHeight() + DOCUMENT_HEIGHT_FUDGE_FACTOR;
}
var oldDocumentHeight = getHeight();
if (isEmbedded()) {
  setInterval(function() {
    var nu = getHeight();
    if (nu !== oldDocumentHeight) {
      oldDocumentHeight = nu;
        window.top.postMessage({
          name: "resize",
          polisFrameId: getPolisFrameId(),
          height: nu
        }, "*");
      }
  }, 200);
}

window.addEventListener("message", function(event) {
  
  // NOTE: event could have any origin, since we're embedded, so be careful here

  if (event.data === "twitterConnected") { // this message is sent from twitterAuthReturn.html
    location.reload();
  }

}, false);

(function() {
  // auth token. keep this in this closure, don't put it on a global. used for cases where cookies are disabled.
  var token;

var p = window.location.pathname;
  // check for token within URL
  if (p.match(/^\/inbox\//) ||
      p.match(/^\/settings\/ep1_[A-Za-z0-9]+/) ||
      p.match(/^\/settings\/enterprise\/ep1_[A-Za-z0-9]+/) ||
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


Handlebars.registerHelper("ifXs", function(arg0) {
  return display.xs() ? arg0.fn(this) : "";
});

Handlebars.registerHelper("ifNotXs", function(arg0) {
  return display.xs() ? "" : arg0.fn(this);
});

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
Handlebars.registerHelper('whatIsPolisHref', function(arg0, options) {
  return "/about";
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
Handlebars.registerHelper("ifEnterprise", function(arg0) {
  return Utils.isEnterpriseUser() ? arg0.fn(this) : "";
});


Handlebars.registerHelper("ifDebugCommentProjection", function(arg0) {
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
  var result = '<a style="color:black" href="' + url + '" target="_blank">' + text + ' &nbsp;<i class="fa fa-external-link" style="font-size: 0.7em;"></i></a>';

  return new Handlebars.SafeString(result);
});


// Partials
Handlebars.registerPartial("polisLogo", PolisLogoPartial);
Handlebars.registerPartial("header", HeaderPartial);
Handlebars.registerPartial("headerWhatIsPolis", HeaderWhatisPolisPartial);
Handlebars.registerPartial("banner", BannerPartial);
Handlebars.registerPartial("banner_pp", BannerParticipantPaysPartial);
Handlebars.registerPartial("trialRemainingStatement", TrialRemainingStatementPartial);
Handlebars.registerPartial("footer", FooterPartial);
Handlebars.registerPartial("tutorialSlidesButtons", TutorialSlidesButtonsPartial);
Handlebars.registerPartial("tutorialSlidesButtonsLeft", TutorialSlidesButtonsLeftPartial);
Handlebars.registerPartial("linkTos", LinkTosPartial);
Handlebars.registerPartial("linkPrivacy", LinkPrivacyPartial);
Handlebars.registerPartial("linkAddPolis", LinkAddPolisPartial);


_.mixin({
    isId: function(n) {
      return n >= 0;
    }
});

if (!window.location.hostname.match(/polis/)) {
    window.document.title = window.location.port;
}

// debug convenience function for deregistering.
window.deregister = function(dest) {
    // relying on server to clear cookies
    return $.post("/api/v3/auth/deregister", {}).always(function() {
      window.location = dest || "/about";
      // Backbone.history.navigate("/", {trigger: true});
    });
};

function isParticipationView() {
  return !!window.location.pathname.match(/^\/[0-9][A-Za-z0-9]+/);
}



// if (isEmbedded()) {
  // $(document.body).css("background-color", "#fff");
// } else {
  // $(document.body).css("background-color", "#f7f7f7");
// }



var uidPromise;
// if (PolisStorage.uidFromCookie()) {
//   uidPromise = $.Deferred().resolve(PolisStorage.uidFromCookie());
// } else {
  uidPromise = $.get("/api/v3/users").then(function(user) {
    // set up global userObject
    window.userObject = $.extend(window.userObject, user);
    window.intercomOptions = {
        app_id: 'nb5hla8s',
        widget: {
          activator: '#IntercomDefaultWidget'
        }  
    };
    if (user.uid) {
      intercomOptions.user_id = user.uid + "";
    }
    if (user.email) {
      intercomOptions.email = user.email;
    }
    if (user.created) {
      intercomOptions.created_at = user.created / 1000 >> 0;
    }
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
      // (function(){var w=window;var ic=w.Intercom;if(typeof ic==="function"){ic('reattach_activator');ic('update',intercomSettings);}else{var d=document;var i=function(){i.c(arguments)};i.q=[];i.c=function(args){i.q.push(args)};w.Intercom=i;function l(){var s=d.createElement('script');s.type='text/javascript';s.async=true;s.src='https://static.intercomcdn.com/intercom.v1.js';var x=d.getElementsByTagName('script')[0];x.parentNode.insertBefore(s,x);}if(w.attachEvent){w.attachEvent('onload',l);}else{w.addEventListener('load',l,false);}}})();
      
      // IntercomModalHack.init();
    }

    if (!window.Intercom) {
      if (!isEmbedded() && !isParticipationView()) {
        window.initIntercom();
      }
    }

    // set up the "exitConv" event
    var currentRoute;
    router.on("route", function(route, params) {
      console.log("route changed from: " + currentRoute+ " to: " + route);
      if (currentRoute === "conversationView") {
        eb.trigger(eb.exitConv);
      }
      currentRoute = route;

      var intercomWait = 0;
      uidPromise.then(function() {
        
        var u = userObject;
        if (!isEmbedded() && !isParticipationView() && (u.email || u.hasTwitter || u.hasFacebook)) {
          var intercomWait = 0;
          if (!window.Intercom) {
            intercomWait = 4000;
          }
          setTimeout(function() {
            window.Intercom('boot', window.intercomOptions);
            window.Intercom('update');
            window.Intercom('reattach_activator');
          }, intercomWait);
        }
      });
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


// FB.Event.subscribe('auth.authResponseChange', function(response) {
//     console.dir(response);
//     console.log('The status of the session changed to: '+response.status);
//     alert(response.status);
// });


// setTimeout(function() {
//       $(document.body).on("click", function() {
//         // FB.getLoginStatus(function(response) {
//         //   if (response.status === 'connected') {
//         //     alert(1);
//         //     console.log('Logged in.');
//         //   }
//         //   else {
//               FB.login();
//           // }
//       });
//     // });
// }, 2000);

  complete(function() {
    Backbone.history.loadUrl();
  });
});
}

