define([
  "view",
  "templates/comment-form",
  "views/commentView"
], function (View, template, CommentView) {
  return Thorax.CollectionView.extend({
    name: "comment-form",
    itemView: CommentView,
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
        $("#comment_form_textarea").val(""); //use this.$
      }
    },
    participantCommented: function(attrs) {
      var that = this; //that = the view
      this.serverClient.submitComment(attrs).then(function() {
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
          pid: this.pidStore.get(this.zid)
        })
      });

    },
    initialize: function(options) {
      this.zid = options.zid;
      this.pidStore = options.pidStore;
      this.collection = options.collection; // comments by me collection
    }
  });
});
