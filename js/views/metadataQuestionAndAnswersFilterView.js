var MetadataAnswerFilterView = require("../views/metadataAnswerFilterView");
var template = require("../templates/metadataQuestionAndAnswersFilter");
var _ = require("../underscore");
var Thorax = require("../thorax");

module.exports = Thorax.CollectionView.extend({
  name: "metadataQuestionAndAnswersFilterView",
  tagName: "li",
  className: "questionText",
  template: template,
  itemView: MetadataAnswerFilterView,
  allowCreate: false,
  allowDelete: false,
  initialize: function(options) {
      this.model = options.model; // question model
      this.collection = options.model.collection; // answers collection
      this.listenTo(this.collection, "change", function() {
        var enabledAnswers = this.collection.filter(function(m) { return !m.get("disabled");});
        enabledAnswers = _.map(enabledAnswers, function(answerModel) { return answerModel.get("pmaid");});
        this.model.set("enabledAnswers", enabledAnswers);
      });
      this.zid = options.zid;
  }
});