var View = require("./view");
var template = require("./templates/passwordResetForm");
var $ = require("jquery");

modules.exports = View.extend({
  name: "passwordResetForm",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
      var urlPrefix = "https://www.polis.io/";
      if (-1 === document.domain.indexOf(".polis.io")) {
          urlPrefix = "http://localhost:5000/";
      }
      this.serialize(function(attrs, release){
        attrs.pwresettoken = that.pwresettoken;
        if(attrs.newPassword !== attrs.pw2){
          alert("Passwords must match.");
          return;
        }
        if(attrs.newPassword.length < 8){
          alert("Password needs to be at least 8 characters.");
          return;
        }
        $.ajax({
          url: urlPrefix + "v3/auth/password",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          crossDomain: true,
          data: attrs
        }).then(function(message) {
          alert(message);
          // reload the page to clear out the password from memory
          window.location = window.location.protocol + "//" + window.location.host + window.location.pathname;
        }, function(errmessage) {
          alert(errmessage);
          release();
        });
      });
    }
  },
  initialize: function(options) {
    this.pwresettoken = options.pwresettoken;
  }
});