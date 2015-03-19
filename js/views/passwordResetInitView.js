var View = require("handlebones").View;
var template = require("../tmpl/passwordResetInitForm");
var serialize = require("../util/serialize");
var URLs = require("../util/url");
var PolisView = require("../lib/PolisView");

var urlPrefix = URLs.urlPrefix;

module.exports = PolisView.extend({
  name: "passwordResetInitForm",
  template: template,
  events: {
    "submit form": function(event){
      event.preventDefault();
      serialize(this, function(attrs){
        if (!/.@./.test(attrs.email)) {
          alert("need email");
          return;
        }
        $.ajax({
          url: urlPrefix + "api/v3/auth/pwresettoken",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: attrs
        }).then(function(message) {
          alert(message);
        }, function(errmessage) {
          alert(errmessage);
        });
      });
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
      errors.push({name: "description",  message: "Please fill in your email address."});
    }
    return errors;
  },
  initialize: function(options) {
    this.authStyleHeader = true;
  }
});