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
      "mouseup input": function(event) {
        $(event.target).select();
      },
      "click :submit": function(event) {
        var formAction = $(event.target).val();
        $(event.target).parents("form:first").attr("data-action",formAction);
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

      this.listenTo(this, "rendered", this.setupTooltips);

    },
    setupTooltips: function(){

      this.$("#topicLabel").popover({
        title: "Topic",
        content: "<p>The topic is the first thing participants see, and should be just a few words.</p>",
        html: true, //XSS risk, not important for now
        trigger: "hover",
        placement: "bottom"
      });

      this.$("#descriptionLabel").popover({
        title: "Description",
        content:  "<ol>"+
                    "<li> Pose an open-ended question: </li>"+
                      "<ul>"+
                        "<li>\"Should we buy widgets?\"</li>"+
                        "<li>\"We are about to phase out gizmos - how will this impact you?\"</li>"+
                      "</ul>"+
                    "<li> Explain any background or context, if necessary, using text & hyperlinks: </li>"+
                      "<ul>"+
                        "<li>\"Last year, we...\"</li>"+
                        "<li>\"The following study showed...\"</li>"+
                        "<li>\"Take a look at the new design...\"</li>"+
                      "</ul>"+
                  "</ol>",
        html: true, //XSS risk, not important for now
        trigger: "hover",
        placement: "bottom"
      });


      this.$("#metaLabel").popover({
        title: "Metadata",
        content: "<p>Seed comments anticipate opinion groups. Metadata, on the other hand, asks participants about facts. It reflects groups you (1) already know exist, (2) want to control for and (3) want to filter based on.</p>" +
                 "<p>Metadata is completely flexible, and you must define both the questions and answers. You can define qualitative categories such as \"What office do you work out of?\" with answers such as \"New York\", \"LA\", \"Boston\", \"No office - remote contractor\". You can also define binary questions such as \"Have you ever lived without healthcare?\", but must manually create the answers \"Yes\" and \"No\". You can also create quantitative scales, where a question such as \"How many times do you check email per day?\" might have answers such as \"1-2\", \"3-5\", \"5+\". </p>" +
                 "<p> When participants enter the conversation, they will be asked to check boxes, and will be able to check as many as apply to them (answers to questions are not mutually exclusive). During the conversation, click the 'Analyze' tab to filter participants in the visualization by metadata. All participants are shown by default. By clicking on \"Boston\", as per the example above, participants who chose that answer will fade out, making it easier to identify patterns of agreement and disagreement in those participants who remain. </p>",
        html: true, //XSS risk, not important for now
        trigger: "hover",
        placement: "top"
      });



      this.$("#shareLabel").popover({
        title: "Sharing",
        content: "While you need an invite token to start conversations, all of your users will be able to join the conversation without one.",
        trigger: "hover",
        placement: "top"
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
