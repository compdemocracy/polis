var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/metadataQuestions");
var Handlebones = require("handlebones");


module.exports = Handlebones.View.extend({
    name: "metadataQuestionsView",
    template: template,
    allowCreate: false,
    itemViewForCollection: MetadataQuestionAndAnswersView, // may be overriden in subclass

    initialize: function(options) {
      this.questions = options.collection; // questions collection
      this.questionsCollectionView = new Handlebones.CollectionView({
        modelView: this.itemViewForCollection,
        collection: this.questions
      });
      this.zid = options.zid;
    }
});