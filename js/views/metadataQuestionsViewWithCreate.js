define([
  'views/metadataQuestionAndAnswersViewWithCreate',
  'views/metadataQuestionsView',
], function (
  MetadataQuestionAndAnswersViewWithCreate,
  MetadataQuestionsView
) {
  return MetadataQuestionsView.extend({
    name: 'metadataQuestionsViewWithCreate',
    itemView: MetadataQuestionAndAnswersViewWithCreate,
    allowCreate: true,
});
});
