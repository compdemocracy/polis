var bbSave = require("../net/bbSave");
var View = require("handlebones").View;
var template = require("../tmpl/create-conversation-form");
var CommentsCollection = require("../collections/comments");
var CommentFormSeedView = require("../views/comment-form-seed");
var ConversationModel = require("../models/conversation");
var MetadataQuestionsViewWithCreate = require("../views/metadataQuestionsViewWithCreate");
var MetadataQuestionCollection = require("../collections/MetadataQuestions");
var PolisStorage = require("../util/polisStorage");
var serialize = require("../util/serialize");

module.exports = View.extend({
    name: "create-conversation-form",
    template: template,
    events: {
      "mouseup input": function(event) {
        $(event.target).select();
      },
      "click #seedCommentsContainer": function() {
        this.$("#seedCommentsCaret").removeClass("icon-caret-right").addClass("icon-caret-down");
        this.$("#hiddenSeedCommentForm").show();
        this.$("#seedCommentsCaret").css({"cursor": "default"});
      },
      "click #metadataFormContainer": function() {
        this.$("#metadataCaret").removeClass("icon-caret-right").addClass("icon-caret-down");
        this.$("#hiddenMetadataForm").show();
        this.$("#metadataFormContainer").css({"cursor": "default"});
      },
      "click #metaDataHelperTextButton": function(){
        this.$("#hiddenMetadataHelperText").toggle();
      },
      "click #xidsFormContainer": function(){
        this.$("#xidsCaret").removeClass("icon-caret-right").addClass("icon-caret-down");
        this.$("#hiddenXidsForm").show();
        this.$("#xidsFormContainer").css({"cursor": "default"});
      },
      "click #moderationFormContainer": function() {
        this.$("#moderationCaret").removeClass("icon-caret-right").addClass("icon-caret-down");
        this.$("#hiddenModerationForm").show();
        this.$("#moderationFormContainer").css({"cursor": "default"});

      },

      "click #seedCommentHelperTextButton": function(){
        this.$("#hiddenSeedCommentHelperText").toggle();
      },

      "click :submit": function(event) {
        this.clearFailMessage();
        var formAction = $(event.target).val();
        $(event.target).parents("form:first").attr("data-action", formAction);
      },
      "click .submitButton": function(event){
        var that = this;
        event.preventDefault();
        var formAction = $(event.target).data("action");

        serialize(this, function(attrs) {

          // !! to make sure these properties exist as 'false', instead of just being absent.
          attrs.is_public = !!attrs.is_public;
          attrs.profanity_filter = !!attrs.profanity_filter;
          attrs.short_url = !!attrs.is_public;
          attrs.spam_filter = !!attrs.spam_filter;
          attrs.strict_moderation = !!attrs.strict_moderation;
          attrs.send_created_email = true;

          var xids = attrs.xidsTextarea;
          if (xids && xids.length) {
            xids = xids.split("\n");
          }
          delete attrs.xidsTextarea;

          var readyToSubmit = !!xids ? 
            $.ajax({
              url: "/v3/users/invite",
              type: "POST",
              dataType: "json",
              xhrFields: {
                  withCredentials: true
              },
              // crossDomain: true,
              data: {
                xids: xids,
                single_use_tokens: true,
                sid: that.model.get("sid")
              }
            }) : 
            $.Deferred().resolve();

          readyToSubmit.then(function(suurls) {

            attrs.verifyMeta = true; // make sure there are answers for each question.
            bbSave(that.model, attrs).then(function(data) {
              that.trigger("done", suurls);
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
      $('#errorDiv').html("<div class=\"alert alert-danger col-sm-6 col-sm-offset-3\">"+message+"</div>");
    },
    clearFailMessage: function() {
      $('#errorDiv').html("");
    },
    initialize: function(options) {

      // ConversationModel
      this.model = options.model;
      var sid = this.model.get("sid");
      var pid = options.pid;

      var data = {
          sid: sid
      };
      var metadataCollection = new MetadataQuestionCollection([], data);

      metadataCollection.fetch({
          data: $.param(data),
          processData: true
      });
      this.metadataQuestionsViewWithCreate = this.addChild(new MetadataQuestionsViewWithCreate({
        collection: metadataCollection,
        sid: sid
      }));

      this.commentsByMe = new CommentsCollection({
        sid: sid
      });

      this.commentForm = this.addChild(new CommentFormSeedView({
        pid: pid,
        collection: this.commentsByMe,
        sid: sid
      }));

    },
    "delete": function() {
      var that = this;
      // var model = this.collection.get(this.id)
      var deleteConfirm = new Konfirm({
        message: "Conversations cannot be deleted during the Beta.",
        success: function(){
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
        cancel: function(){
          return false;
        }
      });
    }
  });