var View = require("handlebones").View;
var template = require("../tmpl/landing-page");
var serialize = require("../util/serialize");

module.exports = View.extend({
  name: "landingPage",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
      var urlPrefix = "https://pol.is/";
      if (-1 === document.domain.indexOf("pol.is")) {
          urlPrefix = "http://localhost:5000/";
      }
      serialize(this, function(attrs){
        $.ajax({
          url: urlPrefix + "v3/beta",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: attrs
        }).then(function(data) {
          that.trigger("done");
          alert("Thank you, your request was recieved.");
        }, function(err) {
          console.dir(arguments);
          alert(err.responseText);
        });
      });
    }
  },
  initialize: function(){
    this.listenTo(this, "rendered", function(){
      var conductorUrl = (/localhost/.test(document.domain) ? "" :  "https://s3.amazonaws.com/pol.is/");
      conductorUrl += "img/conductor.jpeg";
    });
  }
});