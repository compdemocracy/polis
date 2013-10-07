define([
  'views/metadataAnswerViewWithDelete',
  'views/metadataQuestionAndAnswersView',
], function (
  MetadataAnswerViewWithDelete,
  MetadataQuestionAndAnswersView
) {

return MetadataQuestionAndAnswersView.extend({
  name: 'metadataQuestionAndAnswersViewWithCreate',
  itemView: MetadataAnswerViewWithDelete,
  events: {
    "blur .add_answer_form": "hideAddAnswerForm"
  },
  deleteQuestion: function() {
    console.log('delete ' + this.get('pmvid'));
  },
  showAddAnswerForm: function() {
    this.formActive = true;
    this.render();
  },
  hideAddAnswerForm: function() {
    alert('add answer for ' + this.get('pmkid'));
    this.formActive = false;
    this.render();
  },
  allowCreate: true,
  allowDelete: true,
});

});
