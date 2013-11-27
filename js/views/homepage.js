define([
  "view",
  "templates/homepage"
], function (View, template) {
  return View.extend({
    name: "homepage",
    template: template,
    events: {
      "submit form": function(e){
        e.preventDefault();
        this.serialize(function(attrs, release){
          $.ajax({
            url: "/v3/beta/",
            type: "POST",
            dataType: "json",
            xhrFields: {
              withCredentials: true
            },
            // crossDomain: true,
            data: attrs
          }).then(function() {
            release();
          }, function() {
            release();
          });
        });
      },
      "invalid": function(errors){
        console.log("invalid form input" + errors[0].name);
        console.log(errors);
       //_.each(errors, function(err){
          $("input[name=\""+errors[0].name + "\"]").closest("label").append(errors[0].message); // relationship between each input and error name
          //'input[name="firstName"]'
        //})
      }
    },
    validateInput: function(attrs){
      var errors = [];
      if(attrs.email === ""){
        errors.push({name: "description",  message: "hey there... you need an email"});
      }
      return errors;
    }
  });
});
