define([
  'views/metadataAnswerView',
  'templates/metadataQuestionAndAnswers',
  'thorax'
], function (
  MetadataAnswerView,
  template,
  Thorax
) {

return Thorax.CollectionView.extend({
  name: 'metadataQuestionAndAnswersView',
  template: template,
  itemView: MetadataAnswerView,
  allowCreate: false,
  initialize: function(options) {
      var that = this;
      this.model = options.model;
      this.collection = options.model.collection;
      this.zid = options.zid;
  }
});

});
