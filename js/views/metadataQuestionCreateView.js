define([
  'views/metadataQuestionView',
  'templates/analyze',
  'thorax'
], function (
  MetadataQuestionView,
  template,
  Thorax
) {
  return Thorax.CollectionView.extend({
    name: 'metadataQuestionCreateView',
    template: template,
    itemView: MetadataQuestionView,
    initialize: function(options) {
      this.collection = options.collection;
      this.zid = options.zid;
    },
});
});
