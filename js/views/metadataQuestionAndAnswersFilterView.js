var MetadataAnswerFilterView = require("../views/metadataAnswerFilterView");
var template = require("../tmpl/metadataQuestionAndAnswersFilter");
var _ = require("underscore");
var Handlebones = require("handlebones");

module.exports = Handlebones.View.extend({
  name: "metadataQuestionAndAnswersFilterView",
  // tagName: "li",
  // className: "questionText",
  template: template,
  allowCreate: false,
  allowDelete: false,
  itemViewForCollection: MetadataAnswerFilterView,
  initialize: function(options) {
      this.model = options.model; // question model
      this.answers = options.model.collection; // answers collection
      
      this.answersCollectionView = this.addChild(new Handlebones.CollectionView({
        modelView: this.itemViewForCollection,
        collection: this.answers
      }));
      // debugger;

      this.listenTo(this.answers, "change", function() {
        var enabledAnswers = this.answers.filter(function(m) { return !m.get("disabled");});
        enabledAnswers = _.map(enabledAnswers, function(answerModel) { return answerModel.get("pmaid");});
        this.model.set("enabledAnswers", enabledAnswers);
      });
      this.zid = options.zid;
  }
});