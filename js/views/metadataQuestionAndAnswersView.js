var MetadataAnswerView = require("../views/metadataAnswerView");
var template = require("../tmpl/metadataQuestionAndAnswers");
var Handlebones = require("handlebones");

module.exports = Handlebones.View.extend({
  name: "metadataQuestionAndAnswersView",
  template: template,
  allowCreate: false,
  allowDelete: false,
  itemViewForCollection: MetadataAnswerView,
  initialize: function(options) {
      this.model = options.model; // question model
      this.answers = options.model.collection; // answers collection
      this.answersCollectionView = new Handlebones.CollectionView({
        modelView: this.itemViewForCollection,
        collection: this.answers
      });
      this.zid = options.zid;
  }
});