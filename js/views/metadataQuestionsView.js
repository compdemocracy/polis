var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../templates/metadataQuestions");
var Thorax = require("../thorax");

modules.exports = Thorax.CollectionView.extend({
    name: "metadataQuestionsView",
    template: template,
    itemView: MetadataQuestionAndAnswersView,
    allowCreate: false,
    initialize: function(options) {
      this.collection = options.collection; // questions collection
      this.zid = options.zid;
    }
});