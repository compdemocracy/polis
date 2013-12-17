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
  allowDelete: false,
  initialize: function(options) {
      this.model = options.model; // question model
      this.collection = options.model.collection; // answers collection
      this.zid = options.zid;
  }
});

});
