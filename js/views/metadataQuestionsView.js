var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/metadataQuestions");
var Thorax = require("thorax");


module.exports = Thorax.View.extend({
    name: "metadataQuestionsView",
    template: template,
    allowCreate: false,
    itemViewForCollection: MetadataQuestionAndAnswersView, // may be overriden in subclass

    initialize: function(options) {
      this.questions = options.collection; // questions collection
      this.questionsCollectionView = new Thorax.CollectionView({
        itemView: this.itemViewForCollection,
        collection: this.questions
      });
      this.zid = options.zid;
    }
});