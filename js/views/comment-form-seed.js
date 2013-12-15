define([
  "view",
  "templates/comment-form-seed",
  "models/comment",
  "views/commentView"
], function (View, template, CommentModel, CommentView) {
  return Thorax.CollectionView.extend({
    name: "comment-form-seed",
    itemView: CommentView,
    template: template,
      events: {
      "click #comment_button": function(e){
        var that = this;
        e.preventDefault();
        this.serialize(function(attrs, release){
          console.log(attrs);
          that.participantCommented(attrs);
          release();
        });
        $("#comment_form_textarea").val(""); //use this.$
      }
    },
    participantCommented: function(attrs) {
      var that = this; //that = the view
      attrs.pid = this.pid;
      attrs.zid = this.zid;
      var comment = new CommentModel(attrs);
      comment.save().then(function() {
        that.trigger("commentSubmitted"); // view.trigger
        that.updateCollection();
      }, function() {
        alert("failed to send");
      });
    },
    updateCollection: function() {
      this.collection.fetch({
        data: $.param({
          zid: this.zid,
          pid: this.pid
        })
      });

    },
    initialize: function(options) {
      this.zid = options.zid;
      this.pid = options.pid;
      this.collection = options.collection; // comments by me collection
    }
  });
});
