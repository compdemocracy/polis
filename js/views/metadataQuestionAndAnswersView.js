define([
  "views/metadataAnswerView",
  "templates/metadataQuestionAndAnswers",
  "thorax"
], function (
  MetadataAnswerView,
  template,
  Thorax
) {

return Thorax.CollectionView.extend({
  name: "metadataQuestionAndAnswersView",
  template: template,
  itemView: MetadataAnswerView,
  allowCreate: false,
  allowDelete: false
});

});
