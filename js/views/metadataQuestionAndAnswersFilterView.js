define([
  'views/metadataAnswerFilterView',
  'templates/metadataQuestionAndAnswersFilter',
  'underscore',
  'thorax'
], function (
  MetadataAnswerFilterView,
  template,
  _,
  Thorax
) {

return Thorax.CollectionView.extend({
  name: 'metadataQuestionAndAnswersFilterView',
  tagName: 'li',
  className: 'questionText',
  template: template,
  itemView: MetadataAnswerFilterView,
  allowCreate: false,
  allowDelete: false,
  initialize: function(options) {
      var that = this;
      this.model = options.model; // question model
      this.collection = options.model.collection; // answers collection
      this.listenTo(this.collection, "change", function() {
        var enabledAnswers = this.collection.where({enabled:true});
        enabledAnswers = _.map(enabledAnswers, function(answerModel) { return answerModel.get('pmaid');});
        this.model.set('enabledAnswers', enabledAnswers);
      });
      this.zid = options.zid;
  }
});

});
