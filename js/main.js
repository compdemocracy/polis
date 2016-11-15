// init this asap
var preloadHelper = require("./util/preloadHelper");


var $ = require("jquery");
var _ = require("underscore");
var Backbone = require("backbone");
var CurrentUserModel = require("./stores/currentUser");
var display = require("./util/display");
var eb = require("./eventBus");
var Handlebars = require("handlebars");
var MainPolisRouter = require("./routers/main-polis-router");
var Metrics = require("./metrics");
var PolisStorage = require("./util/polisStorage");
var PostMessageUtils = require("./util/postMessageUtils");
var preloadHelper = require("./util/preloadHelper");
var RootView = require("./views/root");
var Utils = require("./util/utils");

// These are required here to ensure they are included in the build.
require("bootstrap_affix");
require("bootstrap_alert");
require("bootstrap_button");
require("bootstrap_collapse");
require("bootstrap_dropdown");
require("bootstrap_popover");
require("bootstrap_tab");
require("bootstrap_tooltip");
require("bootstrap_transition");
require("owl");
require("./util/popoverEach");

// register partials
var FooterPartial = require("./tmpl/footer");
var HeaderPartial = require("./tmpl/header");
var HeaderWhatisPolisPartial = require("./tmpl/headerWhatIsPolis");
var LinkAddPolisPartial = require("./tmpl/link-AddPolis-partial");
var LinkPrivacyPartial = require("./tmpl/link-privacy-partial");
var LinkTosPartial = require("./tmpl/link-TOS-partial");
var PolisLogoPartial = require("./tmpl/polisLogo");

//  require icon partials
var IconFaAngleLeft = require("./tmpl/icon_fa_angle_left");
var IconFaAngleRight = require("./tmpl/icon_fa_angle_right");
var IconFaAsterisk = require("./tmpl/icon_fa_asterisk");
var IconFaBan = require("./tmpl/icon_fa_ban");
var IconFaCircleCheckPartial = require("./tmpl/icon_fa_check_circle");
var iconFaFacebookSquare = require("./tmpl/icon_fa_facebook_square");
var IconFaLightBulb = require("./tmpl/icon_fa_lightbulb_o");
var IconFaTimes = require("./tmpl/icon_fa_times");
var IconFaTwitter = require("./tmpl/icon_fa_twitter");

// require logo partials
var Logo = require("./tmpl/logo");
var LogoInvert = require("./tmpl/logo_invert");

var match = window.location.pathname.match(/ep1_[0-9A-Za-z]+$/);
var encodedParams = match ? match[0] : void 0;
var forceEmbedded = false;

// notify parent iframe when document changes height

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
      PostMessageUtils.postResizeEvent(nu);
    }
  }, 200);
}


function stripParams(paramsToStrip) {
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
}


// remove wipCommentFormText after we've loaded it into the view.
eb.on(eb.doneUsingWipCommentFormText, function() {
  stripParams(["wipCommentFormText"]);
});


eb.on(eb.reload, function(params) {
  location.reload();
});

eb.on(eb.reloadWithMoreParams, function(params) {
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

window.addEventListener("message", function(event) {

  // NOTE: event could have any origin, since we're embedded, so be careful here

  // this message is sent from twitterAuthReturn.html
  if (event.data === "twitterConnected") {
    // location.reload();
    eb.trigger(eb.twitterConnected);
  } else if (event.data === "twitterConnectedCommentForm") {
    eb.trigger(eb.twitterConnectedCommentForm);
  } else if (event.data === "twitterConnectedParticipationView") {
    eb.trigger(eb.twitterConnectedParticipationView);
  } else if (event.data === "twitterConnectedVoteView") {
    eb.trigger(eb.twitterConnectedVoteView);
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



  $.ajaxPrefilter(function(options, originalOptions, jqXHR) {
    if (!options.beforeSend) {
      options.beforeSend = function(xhr) {
        // TODO assert that ajax request is going to our servers (in case of XSS)
        if (token) {
          xhr.setRequestHeader('x-polis', token);
        }
      };
    }
  });
  $(document).ajaxSuccess(function(event, xhr, settings) {
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
  /*eslint-disable */
  /* jshint ignore:start */
  return (window.top != window) || forceEmbedded;
  /* jshint ignore:end */
  /*eslint-enable */
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
  return isIE8() ? "" : arg0.fn(this);
}
Handlebars.registerHelper("ifNotIE8", ifNotIE8);

function ifIos(arg0) {
  return Utils.isIos() ? arg0.fn(this) : "";
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
  url = Handlebars.Utils.escapeExpression(url);
  var result = '<a href="' + url + '">' + text + '</a>';

  return new Handlebars.SafeString(result);
});

Handlebars.registerHelper('linkExternal', function(text, url) {
  text = Handlebars.Utils.escapeExpression(text);
  url = addProtocolToLinkIfNeeded(url);
  url = Handlebars.Utils.escapeExpression(url);
  var result = '<a style="color:black" href="' + url + '" target="_blank">' + text + ' &nbsp;<i class="fa fa-external-link" style="font-size: 0.7em;"></i></a>';

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
Handlebars.registerPartial("iconFaBan", IconFaBan);
Handlebars.registerPartial("iconFaLightBulb", IconFaLightBulb);
Handlebars.registerPartial("iconFaAsterisk", IconFaAsterisk);
Handlebars.registerPartial("iconFaTimes", IconFaTimes);
Handlebars.registerPartial("iconFaFacebookSquare", iconFaFacebookSquare);
Handlebars.registerPartial("iconFaTwitter", IconFaTwitter);
Handlebars.registerPartial("iconFaAngleLeft", IconFaAngleLeft);
Handlebars.registerPartial("iconFaAngleRight", IconFaAngleRight);
Handlebars.registerPartial("logoInvert", LogoInvert);
Handlebars.registerPartial("logo", Logo);



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


window.twitterStatus = function(status) {
  eb.trigger(eb.twitterStatus, status);
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
uidPromise = CurrentUserModel.update().then(function(user) {

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


$.when(
  preloadHelper.acceptLanguagePromise,
  uidPromise).always(function() {

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
      console.log("route changed from: " + currentRoute + " to: " + route);
      if (currentRoute === "conversationView") {
        eb.trigger(eb.exitConv);
      }
      currentRoute = route;

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
