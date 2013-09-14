define([
  'view',
  'templates/comment-form'
], function (View, template) {
  return View.extend({
    name: 'comment-form',
    template: template,
      events: {
      "submit form": function(e){
        var that = this;
        e.preventDefault();
        this.serialize(function(attrs){
          console.log(attrs);
          that.participantCommented(attrs);
        });
        $('#comment_form_textarea').val('')
      },
    },
    participantCommented: function(attrs) {
      var that = this; //that = the view
      this.serverClient.submitComment(attrs).then(function() {
        that.trigger("commentSubmitted"); // view.trigger
      }, function() {
        alert('failed to send');
      });
    }
  });
});
