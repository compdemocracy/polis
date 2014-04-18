var View = require("../view");
var template = require("../tmpl/create-conversation-form");
var CommentsCollection = require("../collections/comments");
var CommentFormSeedView = require("../views/comment-form-seed");
var ConversationModel = require("../models/conversation");
var MetadataQuestionsViewWithCreate = require("../views/metadataQuestionsViewWithCreate");
var MetadataQuestionCollection = require("../collections/MetadataQuestions");
var PolisStorage = require("../util/polisStorage");

module.exports = View.extend({
    name: "create-conversation-form",
    template: template,
    events: {
      "mouseup input": function(event) {
        $(event.target).select();
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
        this.serialize(function(attrs, release) {
          attrs.is_public = !attrs.is_not_public
          if(this.edit===true) {
            switch(formAction) {
              case "draft":
                attrs.is_draft = true;
              break;
              case "publish":
                attrs.is_active = true;
              break;
            }
          } else {
            switch(formAction) {
              case "draft":
                attrs.is_draft = true;
              break;
              case "publish":
                attrs.is_active = true;
                attrs.is_draft = false;
              break;
            }
          }
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
                zid: that.model.get("zid")
              }
            }) : 
            $.Deferred().resolve();

          readyToSubmit.then(function(suurls) {

            attrs.verifyMeta = true; // make sure there are answers for each question.
            that.model.save(attrs).then(function(data) {
              release();
              that.trigger("done", suurls);
            }, function(err) {
              var err = err.responseJSON;
              release();
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
      var zid = this.model.get("zid");
      var pid = options.pid;

      var metadataCollection = new MetadataQuestionCollection([], {
          zid: zid
      });

      metadataCollection.fetch({
          data: $.param({
              zid: zid
          }),
          processData: true
      });
      this.metadataQuestionsViewWithCreate = new MetadataQuestionsViewWithCreate({
        collection: metadataCollection,
        zid: zid
      });

      this.commentsByMe = new CommentsCollection({
        zid: zid
      });

      this.commentForm = new CommentFormSeedView({
        pid: pid,
        collection: this.commentsByMe,
        zid: zid
      });

      this.listenTo(this, "rendered", this.setupInterface);

    },
    setupInterface: function(){

      var $seedCommentsContainer = this.$("#seedCommentsContainer");
      var $hiddenSeedCommentForm = this.$("#hiddenSeedCommentForm");
      var $metadataFormContainer = this.$("#metadataFormContainer");
      var $xidsFormContainer = this.$("#xidsFormContainer");
      var $hiddenMetadataForm = this.$("#hiddenMetadataForm");
      var $hiddenXidsForm = this.$("#hiddenXidsForm");
      var $seedCommentsCaret = this.$("#seedCommentsCaret");
      var $metadataCaret = this.$("#metadataCaret");
      var $xidsCaret = this.$("#xidsCaret");
      var $metaDataHelperTextButton = this.$("#metaDataHelperTextButton");
      var $hiddenMetadataHelperText = this.$("#hiddenMetadataHelperText");
      var $seedCommentHelperTextButton = this.$("#seedCommentHelperTextButton");
      var $hiddenSeedCommentHelperText = this.$("#hiddenSeedCommentHelperText");

      $seedCommentsContainer.css({"cursor": "pointer"});

      $seedCommentsContainer.click(function(){
        
        $seedCommentsCaret.removeClass("icon-caret-right").addClass("icon-caret-down");
        $hiddenSeedCommentForm.show();
        $seedCommentsContainer.css({"cursor": "default"});

      });

      $metadataFormContainer.css({"cursor": "pointer"});

      $metadataFormContainer.click(function(){
        
        $metadataCaret.removeClass("icon-caret-right").addClass("icon-caret-down");
        $hiddenMetadataForm.show();
        $metadataFormContainer.css({"cursor": "default"});

      });

      $xidsFormContainer.css({"cursor": "pointer"});
      $xidsFormContainer.click(function(){
        $xidsCaret.removeClass("icon-caret-right").addClass("icon-caret-down");
        $hiddenXidsForm.show();
        $xidsFormContainer.css({"cursor": "default"});
      });

      $metaDataHelperTextButton.click(function(){
        $hiddenMetadataHelperText.toggle();
      });

      $seedCommentHelperTextButton.click(function(){
        $hiddenSeedCommentHelperText.toggle();
      });

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