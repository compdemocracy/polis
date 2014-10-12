var Handlebones = require("handlebones");
var template = require("../tmpl/create-user-form");
var PolisStorage = require("../util/polisStorage");
var $ = require("jquery");
var serialize = require("../util/serialize");
var URLs = require("../util/url");
var metric = require("../util/gaMetric");
var gaEvent = metric.gaEvent;

var urlPrefix = URLs.urlPrefix;

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
  facebookButtonClicked: function() {
    // FB.getLoginStatus(function(response) {
    //   if (response.status === 'connected') {
    //     alert(1);
    //     console.log('Logged in.');
    //   }
    //   else {


      function getFriends() {
        var dfd = $.Deferred();

        function getMoreFriends(friendsSoFar, urlForNextCall) {
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
            }
          } else {
            // alert('failed to find friends');
            dfd.reject(response);
          }
        });
        return dfd.promise();
      }
      function getInfo() {
        var dfd = $.Deferred();

        FB.api('/me',function (response) {

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
      }

//https://graph.facebook.com/v2.1/10152802017421079/friends?access_token=CAAJZANu53gpEBAJzmrKzNZCu812nPia7pr47z2aKM74DG5567S02lwyJrZAGSubqzstj9itkvx45FN4bKSQfCZB9rZBfWCwJY40sC7H0hK3rIyno4sX0L0FOoYl0KBHtl2hOI7hwatnujahooNLPTDHBFuVoDlLnEQa0Ln3xemkGlZAoEhfFyUvePrQqQyY1oH1KgvTPeMOVXrZB1kqZBu5E6W8ZC8fAmMJQZD&limit=5000&offset=5000&__after_id=enc_Aey5scmiSEQup9MDgY71iuvgmZFvkaw93AvYWftT7uS3KIgTi1sn2qDz9TqcHOiYcG0




          FB.login(function(response) {
            // alert(JSON.stringify(response));

            // console.dir(response);
            $.when(
              getInfo(),
              getFriends()).then(function(fb_public_profile, friendsData) {

              // alert(JSON.stringify(friendsData));

              $.ajax({
                url: "/api/v3/facebookAuthClicked",
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
                data: JSON.stringify({
                  // fb_user_id: FB.getUserID(),
                  // fb_login_status: FB.getLoginStatus(),
                  // fb_auth_response: JSON.stringify(FB.getAuthResponse()),
                  // fb_access_token: FB.getAccessToken(),
                  fb_public_profile: JSON.stringify(fb_public_profile),
                  fb_friends_response: JSON.stringify(friendsData),
                  fb_granted_scopes: response && response.authResponse && response.authResponse.grantedScopes,
                  response: JSON.stringify(response)
                }),
                type: "POST"
              }).then(function() {
                alert("thanks :)");
              }, function(err) {
                alert("eek! there was an error");
                console.dir(err);
              });

              // alert(JSON.stringify(response));
              // getFriends();
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

        });
      // }
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
    this.fb = false;
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
