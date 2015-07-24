var autosize = require("autosize");
var constants = require("../util/constants");
var CurrentUserModel = require("../stores/currentUser");
var View = require("handlebones").View;
var template = require("../tmpl/comment-form");
var CommentModel = require("../models/comment");
var CommentView = require("../views/commentView");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var PolisFacebookUtils = require('../util/facebookButton');
var ProfilePicView = require('../views/profilePicView');
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
    ctx.shouldAutofocusOnTextarea = this.shouldAutofocusOnTextarea || Utils.shouldFocusOnTextareaWhenWritePaneShown();
    ctx.hasTwitter = userObject.hasTwitter;
    ctx.hasFacebook = userObject.hasFacebook;
    return ctx;
  },
  hideMessage: function(id) {
    this.$(id).hide();
    // if there are no other warnings/tips showing, show the default one
    if (this.$(".protip:visible").length === 0) {
      this.$("#not_a_reply_message").show();
    }
  },
  showMessage: function(id) {
    // since there are now other warnings/tips showing, hide the default one
    this.$("#not_a_reply_message").hide();
    this.$(id).show();
  },
  updateOneIdeaPerCommentMessage: function(formText) {
    // TODO I18N
    // Tests to see if there is non-punctuation that follows the end of a sentence.
    if ((formText||"").match(/[\?\.\!].*[a-zA-Z0-9]+/)) {
      this.showMessage("#one_idea_per_comment_message");
    } else {
      this.hideMessage("#one_idea_per_comment_message");
    }
  },
  updateCommentNotQuestionAlert: function(formText) {
    if (formText.indexOf("?") >= 0) {
      this.showMessage("#commentNotQuestionAlert");
    } else {
      this.hideMessage("#commentNotQuestionAlert");
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
      this.showMessage("#commentTooLongAlert");
      this.buttonActive = false;
    } else if (remaining > 0) {
      txt = /*"+ " +*/ remaining;
      this.$("#commentCharCount").css("color", "gray");
      this.$("#comment_button").attr("disabled", null);
      this.$("#comment_button").css("opacity", 1);
      this.hideMessage("#commentTooLongAlert");
      this.buttonActive = true;
    } else {
      txt = remaining;
      this.$("#commentCharCount").css("color", "gray");
      this.$("#comment_button").attr("disabled", null);
      this.$("#comment_button").css("opacity", 1);
      this.hideMessage("#commentTooLongAlert");
      this.buttonActive = true;
    }
    this.$("#commentCharCount").text(txt);
    this.updateOneIdeaPerCommentMessage(formText);
    this.updateCommentNotQuestionAlert(formText);
    eb.trigger(eb.interacted);
  },
  showFormControls: function() {
    // this.$(".alert").hide();
    this.$(".comment_form_control_hideable").show();
  },
  hideFormControls: function() {
    this.$(".comment_form_control_hideable").hide();
    this.$("#commentCharCount").text("");
  },
  reloadPagePreservingCommentText: function() {
    var wipCommentFormText = $("#comment_form_textarea").val();
    var params = {};
    if (wipCommentFormText.length) {
      params.wipCommentFormText = wipCommentFormText;
    }
    eb.trigger(eb.reloadWithMoreParams, params);
  },
  events: {
    "focus #comment_form_textarea": function(e) { // maybe on keyup ?
      this.showFormControls();
    },
    "blur #comment_form_textarea": function(e) {
      var txt = this.$("#comment_form_textarea").val();
      if (!txt || !txt.length) {
        this.hideFormControls();
      }
    },
    "change #comment_form_textarea": "textChange",
    "keyup #comment_form_textarea": "textChange",
    "paste #comment_form_textarea": "textChange",
    "click #facebookButtonCommentForm" : "facebookClicked",
    "click #twitterButtonCommentForm" : "twitterClicked",
    "click #comment_button": function(e){
      var that = this;
      e.preventDefault();

      function doSubmitComment() {
        if (that.buttonActive) {
          that.buttonActive = false;
          serialize(that, function(attrs){
            that.participantCommented(attrs).then(function() {
              that.$("#comment_form_textarea").val("");
              that.hideFormControls();
            }).always(function() {
              that.buttonActive = true;
            });
          });
        }
      }

      var hasSocial = window.userObject.hasFacebook || window.userObject.hasTwitter;
      if (hasSocial) {
        doSubmitComment();
      } else {
        this.showSocialAuthChoices();
      }
    }
  },
  onAuthSuccess: function() {
    this.reloadPagePreservingCommentText();
    // $("#socialButtonsCommentForm").hide();
    // $("#comment_form_controls").show();
  },
  facebookClicked: function(e) {
    e.preventDefault();
    var that = this;
    PolisFacebookUtils.connect().then(function() {
      // wait a bit for new cookies to be ready, or something, then submit comment.
      setTimeout(function() {
        that.onAuthSuccess();
        // CurrentUserModel.update();
      }, 100);
    }, function(err) {
      // alert("facebook error");
    });
  },
  twitterClicked: function(e) {
    var that = this;
    e.preventDefault();

    eb.on(eb.twitterConnected, function() {
      // wait a bit for new cookies to be ready, or something, then submit comment.
      setTimeout(function() {
        that.onAuthSuccess();
        // CurrentUserModel.update();
      }, 100);
    });
    // open a new window where the twitter auth screen will show.
    // that window will redirect back to a simple page that calls window.opener.twitterStatus("ok")
    var params = 'location=0,status=0,width=800,height=400';
    window.open(document.location.origin + "/api/v3/twitterBtn?dest=/twitterAuthReturn", 'twitterWindow', params);
  },
  showSocialAuthChoices: function() {
    $("#comment_form_controls").hide();
    $("#socialButtonsCommentForm").show();
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
      that.showMessage("#commentSentDemoAlert");
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
        $("#comment_form_textarea").hide();
        $("#commentSentAlert").fadeIn(300);
        setTimeout(function() {
          $("#commentSentAlert").fadeOut(500, function() {
            $("#comment_form_textarea").fadeIn(400);
          });
        }, 1500);
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

    this.profilePicView = this.addChild(new ProfilePicView({
      model: CurrentUserModel,
    }));
    
    if (options.wipCommentFormText) {
      this.shouldAutofocusOnTextarea = true;
    }

    this.listenTo(this, "render", function(){
      setTimeout(function() {
        if (!_.isUndefined(options.wipCommentFormText)) {
          $("#comment_form_textarea").val(options.wipCommentFormText);
          eb.trigger(eb.doneUsingWipCommentFormText);
        }
        autosize($("#comment_form_textarea"));
      },100);
    });

  },
});