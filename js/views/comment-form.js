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
        this.serialize(function(attrs, release){
          console.log(attrs);
          that.participantCommented(attrs);
          release();
        });
        $('#comment_form_textarea').val(''); //use this.$
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
