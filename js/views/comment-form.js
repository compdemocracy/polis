var View = require("../view");
var template = require("../tmpl/comment-form");
var CommentModel = require("../models/comment");
var CommentView = require("../views/commentView");

function reject() {
  return $.Deferred().reject();
}
function resolve() {
  return $.Deferred().resolve();
}

module.exports = Thorax.CollectionView.extend({
  name: "comment-form",
  itemView: CommentView,
  template: template,
  events: {
    "click #comment_button": function(e){
      var that = this;
      e.preventDefault();
      this.serialize(function(attrs, release){
        release();
        console.log(attrs);
        that.participantCommented(attrs).then(function() {
          $("#comment_form_textarea").val(""); //use this.$
        });
      });
    }
  },
  participantCommented: function(attrs) {
    var that = this; //that = the view
    attrs.pid = this.pid;
    attrs.zid = this.zid;


    if (/^\s*$/.exec(attrs.txt)) {
      alert("Comment is empty");
      return reject();
    }
    if (attrs.txt.length > 997) {
      alert("Comment is too long");
      return reject();
    }

    // DEMO_MODE
    if (this.pid < 0) {
      that.trigger("commentSubmitted");
      that.updateCollection();
      return resolve();
    }

    var comment = new CommentModel(attrs);
    var promise = comment.save();
    if (!promise) {
      return reject();
    } else {
      promise.then(function() {
        that.trigger("commentSubmitted"); // view.trigger
        that.updateCollection();
      }, function() {
        alert("failed to send");
      });
      return promise;
    }
  },
  updateCollection: function() {
    this.collection.fetch({
      data: $.param({
        zid: this.zid,
        pid: this.pid
      })
    });
  }
});