define([
  "view",
  "templates/passwordResetForm",
  "jquery"
], function (
  View,
  template,
  $
) {

  return View.extend({
    name: "passwordResetForm",
    template: template,
    events: {
      "submit form": function(event){
        var that = this;
        event.preventDefault();
        var urlPrefix = "http://api.polis.io/";
        if (-1 === document.domain.indexOf(".polis.io")) {
            urlPrefix = "http://localhost:5000/";
        }
        this.serialize(function(attrs, release){

          attrs.pwresettoken = that.pwresettoken;
          
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
            release();
          }, function(errmessage) {
            alert(errmessage);
            release();
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

      if(attrs.newPassword !== attrs.pw2){
        errors.push({name: "description",  message: "Passwords must match."});
      }
      if(attrs.newPassword.length < 8){
        errors.push({name: "description",  message: "Password needs to be at least 8 characters."});
      }
      return errors;
    },
    initialize: function(options) {
      this.pwresettoken = options.pwresettoken;
    }
  });
});
