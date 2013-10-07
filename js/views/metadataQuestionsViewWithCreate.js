define([
  'models/metadataQuestion',
  'views/metadataQuestionAndAnswersViewWithCreate',
  'views/metadataQuestionsView',
], function (
  MetadataQuestion,
  MetadataQuestionAndAnswersViewWithCreate,
  MetadataQuestionsView
) {
  return MetadataQuestionsView.extend({
    name: 'metadataQuestionsViewWithCreate',
    itemView: MetadataQuestionAndAnswersViewWithCreate,
    allowCreate: true,
    events: {
      "blur .add_question_form": "hideAddQuestionForm"
    },
    hideAddQuestionForm: function() {
      var that = this;
      var formAction = $(event.target).data('action');
      this.serialize(function(attrs){
        alert('add question ' + JSON.stringify(attrs) + 'for ' + that.zid);

        var data = {
          zid: 32,
          key: "new question " + Math.random(),
        };
        var model = new MetadataQuestion(data);
        model.save();
        that.formActive = false;
        that.render();
      });
    },
    showAddQuestionForm: function() {
      this.formActive = true;
      this.render();
    },
});
});
