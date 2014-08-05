var MetadataAnswerFilterView = require("../views/metadataAnswerFilterView");
var template = require("../tmpl/metadataQuestionAndAnswersFilter");
var _ = require("underscore");
var Handlebones = require("handlebones");

var CV = Handlebones.CollectionView.extend({
  // tagName: "ul",
  className: "questionAnswerList",
  modelView: MetadataAnswerFilterView
});

module.exports = Handlebones.ModelView.extend({
  name: "metadataQuestionAndAnswersFilterView",
  // className: "questionText",
  template: template,
  allowCreate: false,
  allowDelete: false,
  CV: CV,
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model = options.model; // question model
    this.answers = options.model.collection; // answers collection
    
    this.answersCollectionView = this.addChild(new this.CV({
      collection: this.answers
    }));
    this.listenTo(this.answers, "change", function() {
      var enabledAnswers = this.answers.filter(function(m) { return !m.get("disabled");});
      enabledAnswers = _.map(enabledAnswers, function(answerModel) { return answerModel.get("pmaid");});
      this.model.set("enabledAnswers", enabledAnswers);
    });
    this.conversation_id = options.conversation_id;
  }
});