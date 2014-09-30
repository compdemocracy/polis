var constants = require("../util/constants");
var View = require("handlebones").View;
var template = require("../tmpl/comment-form");
var CommentModel = require("../models/comment");
var CommentView = require("../views/commentView");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");

var CommentsByMeView = Handlebones.CollectionView.extend({
  modelView: CommentView
});

function reject() {
  return $.Deferred().reject();
}
function resolve() {
  return $.Deferred().resolve();
}

module.exports = Handlebones.View.extend({
  name: "comment-form",
  template: template,


  // needed to prevent double submissions, which are annoying because they trigger a duplicate alert
  buttonActive: true,

  context: function() {
    var ctx = _.extend({}, this, this.model&&this.model.attributes);
    ctx.is_active = this.parent.model.get("is_active");
    return ctx;
  },
  events: {
    "click #comment_button": function(e){
      var that = this;
      e.preventDefault();
      if (that.buttonActive) {
        that.buttonActive = false;
        console.log("BUTTON ACTIVE FALSE");
        serialize(this, function(attrs){
          that.participantCommented(attrs).then(function() {
            that.$("#comment_form_textarea").val("");
          }).always(function() {
            that.buttonActive = true;
            console.log("BUTTON ACTIVE TRUE");
          });
        });
      }
    }
  },
  participantCommented: function(attrs) {
    var that = this; //that = the view
    attrs.pid = this.pid;
    attrs.conversation_id = this.conversation_id;
    attrs.vote = constants.REACTIONS.AGREE; // participants' comments are automatically agreed to. Needed for now since math assumes every comment has at least one vote.

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
      }, function(args) {
        if (!args || !args.length || !args[0].length) {
          alert("failed to send");
          return;
        }
        var err = args[0][0];
        if (err.status === 409) {
          alert("Duplicate! That comment already exists.");
        } else if (err.responseText === "polis_err_conversation_is_closed"){
          alert("This conversation is closed. No further commenting is allowed.");
        } else {
          alert("failed to send");
        }
      });
      return promise;
    }
  },
  updateCollection: function() {
    this.collection.fetch({
      data: $.param({
        conversation_id: this.conversation_id,
        pid: this.pid
      })
    });
  },
  initialize: function(options) {
    this.pid = options.pid;
    this.conversation_id = options.conversation_id;
    this.collection = options.collection;
    this.commentsByMeView = this.addChild(new CommentsByMeView({
      collection: options.collection
    }));
  },
});