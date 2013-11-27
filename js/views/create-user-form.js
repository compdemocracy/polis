define([
  "view",
  "templates/create-user-form",
  "util/polisStorage",
  "jquery"
], function (
  View,
  template,
  PolisStorage,
  $
) {

  var urlPrefix = "http://api.polis.io/";
  if (-1 === document.domain.indexOf(".polis.io")) {
    urlPrefix = "http://localhost:5000/";
  }

  function createUser(event) {
    var that = this;
    event.preventDefault();
    this.serialize(function(attrs, release){
      PolisStorage.clearAll(); // clear old user - TODO setup deregistration

      // Incorporate options, like zinvite.
      var zinvite = that.model.get("zinvite");
      if (zinvite) {
        attrs.zinvite = zinvite;
      }

      $.ajax({
        url: urlPrefix + "v3/auth/new",
        type: "POST",
        dataType: "json",
        xhrFields: {
            withCredentials: true
        },
        crossDomain: true,
        data: attrs
      }).then(function(data) {
        PolisStorage.uid.set(data.uid);
        PolisStorage.email.set(data.email);
        that.trigger("authenticated");
        release();
      }, function(err) {
          alert("login was unsuccessful");
          release();
      });
    });
  }

  function signIn(event) {
    var that = this;
    event.preventDefault();
    this.serialize(function(attrs, release){
      PolisStorage.clearAll(); // clear old user - TODO setup deregistration

      $.ajax({
        url: urlPrefix + "v3/auth/login",
        type: "POST",
        dataType: "json",
        xhrFields: {
          withCredentials: true
        },
        crossDomain: true,
        data: attrs
      }).then(function(data) {
        PolisStorage.uid.set(data.uid);
        PolisStorage.email.set(data.email);
        release();
        that.trigger("authenticated");
      }, function(err) {
          release();
          alert("login was unsuccessful");
      });
    });
  }

  return View.extend({
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
          return createUser.call(this, event);
        } else {
          return signIn.call(this, event);
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
    validateInput: function(attrs){
      var errors = [];

      if(attrs.email === ""){
        errors.push({name: "description",  message: "hey there... you need an email"});
      }
      return errors;
    },
    initialize: function(options) {
      this.model = options.model;
      this.listenTo(this, "rendered", function(){
        this.$("#conductor").anystretch("img/conductor.jpeg");
      });
    }
  });
});
