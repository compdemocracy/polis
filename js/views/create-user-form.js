var Handlebones = require("handlebones");
var template = require("../tmpl/create-user-form");
var PolisStorage = require("../util/polisStorage");
var $ = require("jquery");
var serialize = require("../util/serialize");
var URLs = require("../util/url");

var urlPrefix = URLs.urlPrefix;

var ModelView = Handlebones.ModelView;

  module.exports = ModelView.extend({
    name: "create-user-form",
    template: template,
    gotoCreate: function() {
      this.model.set("create", true);
    },
    gotoSignIn: function() {
      this.model.set("create", false);
    },
    events: {
      "click .gotoSignIn": "gotoSignIn",
      "click .gotoCreate": "gotoCreate",
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
        url: urlPrefix + "v3/auth/new",
        type: "POST",
        dataType: "json",
        xhrFields: {
            withCredentials: true
        },
        // crossDomain: true,
        data: attrs
      }).then(function(data) {
        that.trigger("authenticated");
      }, function(err) {
          that.onFail("login was unsuccessful");
      });
    });
  },
  signIn: function(event) {
    var that = this;
    that.clearFailMessage();
    event.preventDefault();
    
    serialize(this, function(attrs){
      $.ajax({
        url: urlPrefix + "v3/auth/login",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        // crossDomain: true,
        data: attrs
      }).then(function(data) {
        that.trigger("authenticated");
      }, function(err) {
          that.onFail("login was unsuccessful");
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
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    // this.model = options.model;
    this.listenTo(this, "render", function() {
      var email = that.model.get("email");
      if (email) {
        that.$("#email").val(email);
      }
    });
  }
});