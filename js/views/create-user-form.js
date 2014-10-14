var Handlebones = require("handlebones");
var template = require("../tmpl/create-user-form");
var PolisStorage = require("../util/polisStorage");
var $ = require("jquery");
var serialize = require("../util/serialize");
var URLs = require("../util/url");
var metric = require("../util/gaMetric");
var gaEvent = metric.gaEvent;

var urlPrefix = URLs.urlPrefix;







// FB.getLoginStatus(function(response) {
    //   if (response.status === 'connected') {
    //     alert(1);
    //     console.log('Logged in.');
    //   }
    //   else {


function getFriends() {
  var dfd = $.Deferred();

  function getMoreFriends(friendsSoFar, urlForNextCall) {
    console.log("getMoreFriends");

    return $.get(urlForNextCall).then(function(response) {
      if (response.data.length) {
        for (var i = 0; i < response.data.length; i++) {
          friendsSoFar.push(response.data[i]);
        }
        if (response.paging.next) {
          return getMoreFriends(friendsSoFar, response.paging.next);
        }
        return friendsSoFar;
      } else {
        return friendsSoFar;
      }
    });
  }

  FB.api('/me/friends',function (response) {
    console.log("/me/friends returned");
    if (response && !response.error) {
      // alert(JSON.stringify(response));
      // if (response.data) {
      //   for (var i = 0; i < response.data.length; i++) {
      //     alert(response.data[i]);
      //   }
      // }

      var friendsSoFar = response.data;
      if (response.data.length && response.paging.next) {
        getMoreFriends(friendsSoFar, response.paging.next).then(
          dfd.resolve,
          dfd.reject);
      } else {
        dfd.resolve(friendsSoFar || []);
      }
    } else {
      // alert('failed to find friends');
      dfd.reject(response);
    }
  });
  return dfd.promise();
} // end getFriends

function getInfo() {
  var dfd = $.Deferred();

  FB.api('/me',function (response) {
    console.log("/me done");
    // {"id":"10152802017421079"
    //   "email":"michael@bjorkegren.com"
    //   "first_name":"Mike"
    //   "gender":"male"
    //   "last_name":"Bjorkegren"
    //   "link":"https://www.facebook.com/app_scoped_user_id/10152802017421079/"
    //   "locale":"en_US"
    //   "name":"Mike Bjorkegren"
    //   "timezone":-7
    //   "updated_time":"2014-07-03T06:38:02+0000"
    //   "verified":true}

    if (response && !response.error) {
      // alert(JSON.stringify(response));
      // if (response.data) {
      //   for (var i = 0; i < response.data.length; i++) {
      //     alert(response.data[i]);
      //   }
      // }
      dfd.resolve(response);
    } else {
      // alert('failed to find data');
      dfd.reject(response);
    }
  });
  return dfd.promise();
} // end getInfo

















var ModelView = Handlebones.ModelView;

  module.exports = ModelView.extend({
    name: "create-user-form",
    template: template,
    gotoCreate: function() {
      this.model.set("create", true);
      gaEvent("SignUp", "land");
    },
    gotoSignIn: function() {
      this.model.set("create", false);
      gaEvent("Session", "land");
    },
    events: {
      "click .gotoSignIn": "gotoSignIn",
      "click .gotoCreate": "gotoCreate",
      "click .facebook-button": "facebookButtonClicked",
      "click #connectFb": "facebookButtonClicked",
      "submit form": function(event){
        if (this.model.get("create")) {
          return this.createUser.call(this, event);
        } else {
          return this.signIn.call(this, event);
        }
      },
      "invalid": function(errors){
        console.log("invalid form input" + errors[0].name);
        console.log(errors);

       //_.each(errors, function(err){
          $("input[name=\""+errors[0].name+"\"]").closest("label").append(errors[0].message); // relationship between each input and error name
        //})
      }
    },
    onFail: function(message) {
      $('#errorDiv').html("<div class=\"alert alert-danger col-sm-6 col-sm-offset-3\">"+message+"</div>");
    },
    clearFailMessage: function() {
      $('#errorDiv').html("");
    },
    createUser: function(event) {
    var that = this;
    that.clearFailMessage();
    event.preventDefault();

    serialize(this, function(attrs){
        // Incorporate options, like zinvite.
        var zinvite = that.model.get("zinvite");
        if (zinvite) {
          attrs.zinvite = zinvite;
        }
      if (!attrs.email || !/.@./.exec(attrs.email)) {
        return that.onFail("Email is missing \"@\"");
      }
      if (!attrs.password || attrs.password.length < 8) {
        return that.onFail("Password must be 8 or more characters.");
      }
      $.ajax({
        url: urlPrefix + "api/v3/auth/new",
        type: "POST",
        dataType: "json",
        xhrFields: {
            withCredentials: true
        },
        // crossDomain: true,
        data: attrs
      }).then(function(data) {
        that.trigger("authenticated");
        gaEvent("SignUp", "done");
        setTimeout(function() {
          gaEvent("Session", "create", "signUp");
        }, 100);
      }, function(err) {
          that.onFail("login was unsuccessful");
          gaEvent("SignUp", "createFail", "signUp");
      });
    });
  },
  signIn: function(event) {
    var that = this;
    that.clearFailMessage();
    event.preventDefault();
    
    serialize(this, function(attrs){
      $.ajax({
        url: urlPrefix + "api/v3/auth/login",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        // crossDomain: true,
        data: attrs
      }).then(function(data) {
        that.trigger("authenticated");
        gaEvent("Session", "create", "signIn");
      }, function(err) {
          that.onFail("login was unsuccessful");
          gaEvent("Session", "createFail", "signIn");
      });
    });
  },
  validateInput: function(attrs){
    var errors = [];
    if(attrs.email === ""){
      errors.push({name: "description",  message: "hey there... you need an email"});
    }
    return errors;
  },
  onFbLoginOk: function(response, optionalPassword) {
    var that = this;
    console.log("onFbLoginOk");
    console.dir(response);
    $.when(
      getInfo(),
      getFriends()).then(function(fb_public_profile, friendsData) {

        // alert(JSON.stringify(friendsData));
        console.log("got info and friends");

        var data = {
            // fb_user_id: FB.getUserID(),
            // fb_login_status: FB.getLoginStatus(),
            // fb_auth_response: JSON.stringify(FB.getAuthResponse()),
            // fb_access_token: FB.getAccessToken(),
            fb_public_profile: JSON.stringify(fb_public_profile),
            fb_friends_response: JSON.stringify(friendsData),
            response: JSON.stringify(response)
        };
        if (fb_public_profile.email) {
          data.fb_email = fb_public_profile.email;
        } else {
          data.provided_email = prompt("Please enter your email address.");
        }
        var hname = [fb_public_profile.first_name, fb_public_profile.last_name].join(" ");
        if (hname.length) {
          data.hname = hname;
        }
        if (response && response.authResponse && response.authResponse.grantedScopes) {
          data.fb_granted_scopes = response.authResponse.grantedScopes;
        }
        if (optionalPassword) {
          data.password = optionalPassword;
        }

        $.ajax({
          url: "/api/v3/auth/facebook",
          contentType: "application/json; charset=utf-8",
          headers: {
              //"Cache-Control": "no-cache"  // no-cache
              "Cache-Control": "max-age=0"
          },
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          dataType: "json",
          data: JSON.stringify(data),
          type: "POST"
        }).then(function() {
          that.trigger("authenticated");
          gaEvent("Session", "create", "signIn");
        }, function(err) {
          console.dir(err);
          if (err.responseText && /polis_err_user_with_this_email_exists/.test(err.responseText)) {
            // var password = prompt("A pol.is user "+data.fb_email+", the same email address as associted with your facebook account, already exists. Enter your pol.is password to enable facebook login for your pol.is account.");
            // that.linkMode = true;
            that.model.set({
              create: false, // don't show create account stuff, account exists.
              linkMode: true,
              email: data.fb_email,
            });
          } else {
            alert(err.responseText);
          }
        });

        // alert(JSON.stringify(response));
        // getFriends();
    }, function(err) {
      console.error(err);
      console.dir(arguments);
    });
  }, // end onFbLoginOk
  facebookButtonClicked: function() {
    var that = this;
    // second time, user may have populated password field in reponse to "polis_err_user_with_this_email_exists" error
    var password = this.$("#password").val() || void 0;

    function fbLoginPrompt() {
        FB.login(
          function(x) {
            return that.onFbLoginOk(x, password);
          }, {
            return_scopes: true, // response should contain the scopes the user allowed
            scope: [
              // 'taggable_friends', // requires review.
              // invitable_friends NOTE: only for games with a fb Canvas presence, so don't use this
              'public_profile',
              'user_friends',
              'email'
            ].join(',')
          });
    }

    if (FB.getAuthResponse()) {
      FB.getLoginStatus(function(x) {
        if (x.status === "connected") {
          that.onFbLoginOk(x, password);
        } else {
          // this code path may trigger popup blockers.
          // ideally the fbLoginPrompt call below is called instead.
          fbLoginPrompt();
        }
      });
    } else {
      // test for FB.getUserID() so we can show the prompt on the same stack, preventing the popup-blocker from showing.
      fbLoginPrompt();
    }
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx.social = ctx.fb; // || ctx.twitter || ...
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.authStyleHeader = true;
    var that = this;
    this.fb = !this.model.get("showEmailWelcome");
    // this.model = options.model;
    this.listenTo(this, "render", function() {
      var email = that.model.get("email");
      if (email) {
        that.$("#email").val(email);
      }

      // TODO do this differently
      // setTimeout(function() {
      //   FB.XFBML.parse();
      // }, 100);

    });
  }
});
