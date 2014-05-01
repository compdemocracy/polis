var constants = require("../util/constants");
var View = require("handlebones").View;
var template = require("../tmpl/comment-form-seed");
var CommentModel = require("../models/comment");
var CommentView = require("../views/commentView");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");


var CommentsByMeView = Handlebones.CollectionView.extend({
  modelView: CommentView
});


module.exports = Handlebones.View.extend({
  name: "comment-form-seed",
  template: template,
    events: {
    "click #comment_button": function(e){
      var that = this;
      e.preventDefault();
      serialize(this, function(attrs){
        that.participantCommented(attrs);
      });
      $("#comment_form_textarea").val(""); //use this.$
    }
  },
  participantCommented: function(attrs) {
    var that = this; //that = the view
    attrs.pid = this.pid;
    attrs.zid = this.zid;
    attrs.vote = constants.REACTIONS.PASS; // Preseeded comments are automatically passed. Needed for now since math assumes every comment has at least one vote.
    var comment = new CommentModel(attrs);
    comment.save().then(function() {
      that.trigger("commentSubmitted"); // view.trigger
      that.updateCollection();
    }, function(err) {
      console.error("failed to send comment");
      console.error(err)
    });
  },
  updateCollection: function() {
    this.collection.fetch({
      data: $.param({
        zid: this.zid
      })
    });
  },
  initialize: function(options) {
    this.zid = options.zid;
    this.pid = options.pid;
    this.collection = options.collection; // comments by me collection
    this.commentsByMeView = this.addChild(new CommentsByMeView({
      collection: this.collection
    }));
  }
});