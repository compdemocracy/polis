var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/metadataQuestions");
var Thorax = require("thorax");


module.exports = Thorax.CollectionView.extend({
    name: "metadataQuestionsView",
    template: template,
    itemView: MetadataQuestionAndAnswersView,
    allowCreate: false,
    initialize: function(options) {
      this.collection = options.collection; // questions collection
      this.zid = options.zid;
    }
});