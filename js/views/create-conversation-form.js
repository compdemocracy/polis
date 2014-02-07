var View = require("../view");
var template = require("../templates/create-conversation-form");
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
        var formAction = $(event.target).val();
        $(event.target).parents("form:first").attr("data-action", formAction);
      },
      "click .submitButton": function(event){
        var that = this;
        event.preventDefault();
        var formAction = $(event.target).data("action");
        this.serialize(function(attrs, release) {
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
          this.model.save(attrs).then(function(data) {
            release();
            that.trigger("done");
          }, function(err) {
            release();
            alert("unable to save");
          });
        });
      }
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
      var $hiddenMetadataForm = this.$("#hiddenMetadataForm");
      var $seedCommentsCaret = this.$("#seedCommentsCaret");
      var $metadataCaret = this.$("#metadataCaret");
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