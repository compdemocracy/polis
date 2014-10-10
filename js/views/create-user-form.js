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
        FB.api('/me/friends',function (response) {
          if (response && !response.error) {
            alert(JSON.stringify(response));
            if (response.data) {
              for (var i = 0; i < response.data.length; i++) {
                alert(response.data[i]);
              }
            }
          } else {
            alert('failed');
          }
        });
      }

          FB.login(function(response) {
            alert(JSON.stringify(response));
            getFriends();
          }, {
            return_scopes: true, // response should contain the scopes the user allowed
            scope: 'email,user_friends'
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
