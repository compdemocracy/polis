var bbSave = require("../net/bbSave");
var View = require("handlebones").View;
var template = require("../tmpl/create-conversation-form");
var CommentsCollection = require("../collections/comments");
var CommentFormSeedView = require("../views/comment-form-seed");
var ConversationModel = require("../models/conversation");
var MetadataQuestionsViewWithCreate = require("../views/metadataQuestionsViewWithCreate");
var MetadataQuestionCollection = require("../collections/metadataQuestions");
var PolisStorage = require("../util/polisStorage");
var PolisView = require("../lib/PolisView");
var serialize = require("../util/serialize");

module.exports = PolisView.extend({
  name: "create-conversation-form",
  template: template,
  events: {
    "mouseup input": function(event) {
      $(event.target).select();
    },
    "click #seedCommentsContainer": function() {
      this.$("#seedCommentsCaret").removeClass("fa fa-caret-right").addClass("fa fa-caret-down");
      this.$("#hiddenSeedCommentForm").show();
      this.$("#seedCommentsCaret").css({
        "cursor": "default"
      });
    },
    "click #metadataFormContainer": function() {
      this.$("#metadataCaret").removeClass("fa fa-caret-right").addClass("fa fa-caret-down");
      this.$("#hiddenMetadataForm").show();
      this.$("#metadataFormContainer").css({
        "cursor": "default"
      });
    },
    "click #metaDataHelperTextButton": function() {
      this.$("#hiddenMetadataHelperText").toggle();
    },
    "click #xidsFormContainer": function() {
      this.$("#xidsCaret").removeClass("fa fa-caret-right").addClass("fa fa-caret-down");
      this.$("#hiddenXidsForm").show();
      this.$("#xidsFormContainer").css({
        "cursor": "default"
      });
    },
    "click #moderationFormContainer": function() {
      this.$("#moderationCaret").removeClass("fa fa-caret-right").addClass("fa fa-caret-down");
      this.$("#hiddenModerationForm").show();
      this.$("#moderationFormContainer").css({
        "cursor": "default"
      });

    },

    "click #seedCommentHelperTextButton": function() {
      this.$("#hiddenSeedCommentHelperText").toggle();
    },

    "click :submit": function(event) {
      this.clearFailMessage();
      var formAction = $(event.target).val();
      $(event.target).parents("form:first").attr("data-action", formAction);
    },
    "click #submitButton": function(event) {
      var that = this;
      event.preventDefault();
      var formAction = $(event.target).data("action");

      serialize(this, function(attrs) {

        // !! to make sure these properties exist as 'false', instead of just being absent.
        attrs.profanity_filter = !!attrs.profanity_filter;
        attrs.short_url = !!attrs.short_url;
        attrs.spam_filter = !!attrs.spam_filter;
        attrs.strict_moderation = !!attrs.strict_moderation;
        attrs.send_created_email = true;
        attrs.is_draft = false; // not a draft anymore
        if (window.context) {
          attrs.context = window.context;
        }

        var xids = attrs.xidsTextarea;
        if (xids && xids.length) {
          xids = xids.split("\n");
        }
        delete attrs.xidsTextarea;

        attrs.verifyMeta = true; // make sure there are answers for each question.

        attrs = $.extend(attrs, that.paramsFromPath);

        bbSave(that.model, attrs).then(function(data, response) {
          // LTI redirect
          if (response.lti_redirect) {
            var o = response.lti_redirect;
            if (o.return_type === "iframe") {
              // Tell the LTI tool about the new conversation, so it can generate an iframe embed code.
              window.location = o.launch_presentation_return_url + "?" + [
                ["return_type", o.return_type].join("="), ["url", o.url].join("="), ["width", o.width].join("="), ["height", o.height].join("="),
              ].join("&");
            } else if (o.return_type === "url") {
              // Tell the LTI tool about the new conversation, so it can generate an iframe embed code.
              window.location = o.launch_presentation_return_url + "?" + [
                ["return_type", o.return_type].join("="), ["url", o.url].join("="), ["title", o.title].join("="), ["text", o.text].join("="), ["target", o.target].join("="),
              ].join("&");
            } else {
              alert("LTI error 42");
            }
            return;

          }
          // NOTE: the suurl generation must take place after the PUT conversations call, since the conversation_id may change (and the conversation_id is included in the suurls)
          var promise = !!xids ?
            $.ajax({
              url: "/api/v3/users/invite",
              type: "POST",
              dataType: "json",
              xhrFields: {
                withCredentials: true
              },
              // crossDomain: true,
              data: {
                xids: xids,
                single_use_tokens: true,
                conversation_id: that.model.get("conversation_id")
              }
            }) : $.Deferred().resolve();

          promise.then(function(suurls) {
            that.trigger("done", {
              suurls: suurls,
              conversation_id: response.conversation_id
            });
          }, function(model, err) {
            err = err.responseText;
            if (err === "polis_err_missing_metadata_answers") {
              that.onFail("Each participant question needs at least one answer. (They are multiple-choice)");
            } else {
              that.onFail("unable to save");
            }
          });
        }, function(err) {
          that.onFail("failed to create single-use URLs");
        });
      });
    }
  },

  onFail: function(message) {
    $('#errorDiv').html("<div class=\"alert alert-danger col-sm-6 col-sm-offset-3\">" + message + "</div>");
  },
  clearFailMessage: function() {
    $('#errorDiv').html("");
  },
  initialize: function(options) {

    // ConversationModel
    this.model = options.model;
    this.contextString = options.model.get("context");
    this.paramsFromPath = options.paramsFromPath;
    var conversation_id = this.model.get("conversation_id");
    var pid = options.pid;

    var data = {
      conversation_id: conversation_id
    };
    var metadataCollection = new MetadataQuestionCollection([], data);

    metadataCollection.fetch({
      data: $.param(data),
      processData: true
    });
    this.metadataQuestionsViewWithCreate = this.addChild(new MetadataQuestionsViewWithCreate({
      collection: metadataCollection,
      conversation_id: conversation_id
    }));

    this.commentsByMe = new CommentsCollection({
      conversation_id: conversation_id
    });

    this.commentForm = this.addChild(new CommentFormSeedView({
      pid: pid,
      collection: this.commentsByMe,
      conversation_id: conversation_id
    }));

  },
  "delete": function() {
    var that = this;
    // var model = this.collection.get(this.id)
    var deleteConfirm = new Konfirm({
      message: "Conversations cannot be deleted during the Beta.",
      success: function() {
        that.model.destroy().then(function(data) {
          alert("deleted!");
          that.trigger("done");
        }, function(err) {
          alert("delete failed");
        });
        // conversationsCollection.remove(model);
        // var inboxView = new InboxView({
        //   collection: conversationsCollection,
        //   active: true
        // });
      },
      cancel: function() {
        return false;
      }
    });
  }
});
