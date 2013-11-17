define([
  "view",
  "templates/login-form",
  "util/polisStorage",
], function (
  View,
  template,
  PolisStorage
) {
  return View.extend({
    name: "login-form",
    template: template,
    events: {
      "submit form": function(event){
        var that = this;
        event.preventDefault();
        var urlPrefix = "http://api.polis.io/";
        if (-1 === document.domain.indexOf(".polis.io")) {
            urlPrefix = "http://localhost:5000/"; // TODO centralize the network config
        }
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
      },
      "invalid": function(errors){
        console.log("invalid form input" + errors[0].name);
        console.log(errors);

       //_.each(errors, function(err){
          $('input[name="'+errors[0].name+'"]').closest("label").append(errors[0].message); // relationship between each input and error name
          //'input[name="firstName"]'
        //})
      }
    },
    validateInput: function(attrs){
      var errors = [];
      if(attrs.email === ''){
        errors.push({name: "description",  message: "hey there... you need an email"});
      }
      return errors;
    },
    initialize: function(options) {
      this.listenTo(this, "rendered", function(){
        this.$("#conductor").anystretch("img/conductor.jpeg");
      });
    },
  });
});
