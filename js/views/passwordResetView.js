var template = require("../tmpl/passwordResetForm");
var $ = require("jquery");
var serialize = require("../util/serialize");
var PolisView = require("../lib/PolisView");
var URLs = require("../util/url");

var urlPrefix = URLs.urlPrefix;

module.exports = PolisView.extend({
  name: "passwordResetForm",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
      serialize(this, function(attrs){
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
          url: urlPrefix + "api/v3/auth/password",
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
          window.location = window.location.protocol + "//" + window.location.host + "/user/login";
        }, function(errmessage) {
          alert(errmessage);
        });
      });
    }
  },
  initialize: function(options) {
    this.authStyleHeader = true;
    this.pwresettoken = options.pwresettoken;
  }
});