define([
  "view",
  "templates/create-conversation-form",
  "collections/comments",
  "views/comment-form",
  "models/conversation",
  "views/metadataQuestionsViewWithCreate",
  "collections/MetadataQuestions",
  "util/polisStorage"
], function (
  View,
  template,
  CommentsCollection,
  CommentFormView,
  ConversationModel,
  MetadataQuestionsViewWithCreate,
  MetadataQuestionCollection,
  PolisStorage
) {
  return View.extend({
    name: "create-conversation-form",
    template: template,
    events: {
      "click :submit": function(event) {
        var formAction = $(event.target).val();
        $(event.target).parents("form:first").attr("data-action",formAction);
      },
      "submit form": function(event){
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


      this.commentsByMe = new CommentsCollection();

      this.commentForm = new CommentFormView({
        pidStore: PolisStorage.pid,
        collection: this.commentsByMe,
        zid: zid
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
    },
    saveDraft: function(){
      var that = this;
//      var model = this.collection.get(this.id)
      this.model.save().then(function(data) {
        alert("draft saved!");
        that.trigger("done");
      }, function(err) {
        alert("saveDraft failed");
      });
    }
  });
});
