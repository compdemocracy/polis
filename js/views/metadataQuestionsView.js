define([
  "views/metadataQuestionAndAnswersView",
  "templates/metadataQuestions",
  "thorax"
], function (
  MetadataQuestionAndAnswersView,
  template,
  Thorax
) {
  return Thorax.CollectionView.extend({
    name: "metadataQuestionsView",
    template: template,
    itemView: MetadataQuestionAndAnswersView,
    allowCreate: false,
    initialize: function(options) {
      this.collection = options.collection; // questions collection
      this.zid = options.zid;
    }
});
});
