define([
  'views/metadataAnswerView',
  'templates/metadataQuestion',
  'thorax'
], function (
  MetadataAnswerView,
  template,
  Thorax
) {

return Thorax.CollectionView.extend({
  name: 'metadataQuestionView',
  template: template,
  itemView: MetadataAnswerView,
  events: {
    "mouseup input": function(event) {
      console.log('selected');
      $(event.target).select();
    }
  },
  initialize: function(options) {
      var that = this;
      this.model = options.model;
      this.collection = options.model.collection;
      this.zid = options.zid;
  }
});

});
