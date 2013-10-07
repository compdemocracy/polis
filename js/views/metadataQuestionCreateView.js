define([
  'views/metadataAnswerCreateView',
  'templates/metadataQuestions',
  'thorax'
], function (
  MetadataAnswerCreateView,
  template,
  Thorax
) {
  return Thorax.CollectionView.extend({
    name: 'metadataQuestionCreateView',
    template: template,
    itemView: MetadataAnswerCreateView,
    initialize: function(options) {
      this.collection = options.collection;
      this.zid = options.zid;
      this.allowCreate = true;
    },
});
});
