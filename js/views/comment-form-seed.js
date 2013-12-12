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
      attrs.pid = this.pidStore.get(this.zid);
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
          pid: this.pidStore.get(this.zid)
        })
      });

    },
    initialize: function(options) {
      this.zid = options.zid;
      this.pidStore = options.pidStore;
      this.collection = options.collection; // comments by me collection
      this.listenTo(this, "rendered", function(){
        this.$("#seedPopover").popover({
        title: "Seed Comments",
        content: "<p> Use seed comments to outline opinions & options that are 'knowns', to focus participants and give them ideas of what to write themselves. If users have additional ideas, they will be able to write those and submit them during the conversation by clicking the 'Write' tab. </p>",
        html: true, //XSS risk, not important for now
        trigger: "hover",
        placement: "bottom"
      });
      });
    }
  });
});
