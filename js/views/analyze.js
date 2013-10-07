define([
  'views/metadataQuestionView',
  'templates/metadataQuestions',
  'thorax'
], function (
  MetadataQuestionView,
  template,
  Thorax
) {
  return Thorax.CollectionView.extend({
    name: 'analyze',
    template: template,
    itemView: MetadataQuestionView,
    initialize: function(options) {
      this.collection = options.collection;
      this.zid = options.zid;
      this.allowCreate = false;
    },
});
});
