define([
  'view',
  'templates/landing-page',
  'anystretch'
], function (View, template) {
  return View.extend({
    name: 'landingPage',
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

          $.ajax({
            url: urlPrefix + "v3/beta",
            type: "POST",
            dataType: "json",
            xhrFields: {
                withCredentials: true
            },
            crossDomain: true,
            data: attrs
          }).then(function(data) {
            release();
            that.trigger("done");
            alert("Thank you, your request was recieved.");
          }, function(err) {
            release();
            console.dir(arguments);
            alert(err.responseText);
          });
        });
      },
    },
    initialize: function(){
      this.listenTo(this, 'rendered', function(){
        this.$('#conductor').anystretch("img/conductor.jpeg");
      });
    }
  });
});
