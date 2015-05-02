var autosize = require("autosize");
var constants = require("../util/constants");
var View = require("handlebones").View;
var template = require("../tmpl/comment-form");
var CommentModel = require("../models/comment");
var CommentView = require("../views/commentView");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");
var Utils = require("../util/utils");

var CHARACTER_LIMIT = constants.CHARACTER_LIMIT;

var CommentsByMeView = Handlebones.CollectionView.extend({
  modelView: CommentView
});

function reject() {
  return $.Deferred().reject();
}
function resolve() {
  return $.Deferred().resolve();
}

module.exports = Handlebones.ModelView.extend({
  name: "comment-form",
  template: template,


  // needed to prevent double submissions, which are annoying because they trigger a duplicate alert
  buttonActive: true,

  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx = _.extend(ctx, this, this.model&&this.model.attributes);
    ctx.is_active = this.parent.model.get("is_active");
    ctx.shouldAutofocusOnTextarea = Utils.shouldFocusOnTextareaWhenWritePaneShown();
    return ctx;
  },
  updateOneIdeaPerCommentMessage: function(formText) {
    // TODO I18N
    // Tests to see if there is non-punctuation that follows the end of a sentence.
    if ((formText||"").match(/[\?\.\!].*[a-zA-Z0-9]+/)) {
      this.$("#one_idea_per_comment_message").show();
    } else {
      this.$("#one_idea_per_comment_message").hide();
    }
  },
  updateCommentNotQuestionAlert: function(formText) {
    if (formText.indexOf("?") >= 0) {
      this.$("#commentNotQuestionAlert").show();
    } else {
      this.$("#commentNotQuestionAlert").hide();
    }
  },
  textChange: function() {
    var formText = $(arguments[0].target).val();
    var len = formText.length;
    var remaining = CHARACTER_LIMIT - len;
    var txt;
    if (remaining < 0) {
      // txt = "- " + remaining;
      txt = remaining;
      this.$("#commentCharCount").css("color", "red");
      this.$("#comment_button").attr("disabled", "disabled");
      this.$("#comment_button").css("opacity", 0.3);
      this.$("#commentTooLongAlert").show();
      this.buttonActive = false;
    } else if (remaining > 0) {
      txt = "+ " + remaining;
      this.$("#commentCharCount").css("color", "gray");
      this.$("#comment_button").attr("disabled", null);
      this.$("#comment_button").css("opacity", 1);
      this.$("#commentTooLongAlert").hide();
      this.buttonActive = true;
    } else {
      txt = remaining;
      this.$("#commentCharCount").css("color", "gray");
      this.$("#comment_button").attr("disabled", null);
      this.$("#comment_button").css("opacity", 1);
      this.$("#commentTooLongAlert").hide();
      this.buttonActive = true;
    }
    this.$("#commentCharCount").text(txt);
    this.updateOneIdeaPerCommentMessage(formText);
    this.updateCommentNotQuestionAlert(formText);
    eb.trigger(eb.interacted);
  },
  events: {
    "focus #comment_form_textarea": function(e) { // maybe on keyup ?
      this.$(".alert").hide();
    },
    "change #comment_form_textarea": "textChange",
    "keyup #comment_form_textarea": "textChange",
    "paste #comment_form_textarea": "textChange",
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
      that.$("#commentSentDemoAlert").show();
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
        that.$("#commentSentAlert").show();
      }, function(args) {
        if (!args || !args.length || !args[0].length) {
          alert("failed to send");
          return;
        }
        var err = args[0][0];
        if (err.status === 409) {

          // that.model.set({
          //   error: "Duplicate!",
          //   errorExtra: "That comment already exists.",
          // });
          alert("Duplicate! That comment already exists.");
        } else if (err.responseText === "polis_err_conversation_is_closed"){

          // that.model.set({
          //   error: "This conversation is closed.",
          //   errorExtra: "No further commenting is allowed.",
          // });
          alert("This conversation is closed. No further commenting is allowed.");
        } else {

          // that.model.set({
          //   error: "Error sending comment.",
          //   errorExtra: "Please try again later.",
          // });
          alert("Error sending comment, please try again later.");
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
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.pid = options.pid;
    this.model = options.model;
    this.conversation_id = options.conversation_id;
    this.collection = options.collection;
    this.commentsByMeView = this.addChild(new CommentsByMeView({
      collection: options.collection
    }));

    this.listenTo(this, "render", function(){
      setTimeout(function() {
        autosize($("#comment_form_textarea"));
      },100);
    });

  },
});