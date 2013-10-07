define([
  'views/metadataAnswerView',
  'templates/metadataQuestionWithAnswers',
  'thorax'
], function (
  MetadataAnswerView,
  template,
  Thorax
) {

return Thorax.CollectionView.extend({
  name: 'metadataAnswerCreateView',
  template: template,
  itemView: MetadataAnswerView,
  initialize: function(options) {
      var that = this;
      this.model = options.model;
      this.collection = options.model.collection;
      this.zid = options.zid;
      this.allowCreate = true;
  }
});

});
