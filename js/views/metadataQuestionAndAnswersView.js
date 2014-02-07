var MetadataAnswerView = require("./views/metadataAnswerView");
var template = require("./templates/metadataQuestionAndAnswers");
var Thorax = require("./thorax");

module.exports = Thorax.CollectionView.extend({
  name: "metadataQuestionAndAnswersView",
  template: template,
  itemView: MetadataAnswerView,
  allowCreate: false,
  allowDelete: false,
  initialize: function(options) {
      this.model = options.model; // question model
      this.collection = options.model.collection; // answers collection
      this.zid = options.zid;
  }
});