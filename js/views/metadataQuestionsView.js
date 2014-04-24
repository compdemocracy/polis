var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/metadataQuestions");
var Handlebones = require("handlebones");


var CV = Handlebones.CollectionView.extend({
  tagName: "ul",
  modelView: MetadataQuestionAndAnswersView
});


module.exports = Handlebones.View.extend({
    name: "metadataQuestionsView",
    template: template,
    allowCreate: false,
    CollectionView: CV,
    // itemViewForCollection: MetadataQuestionAndAnswersView, // may be overriden in subclass

    initialize: function(options) {
      // this.questions = options.collection; // questions collection
      this.questionsCollectionView = this.addChild(new this.CollectionView({
        // modelView: this.itemViewForCollection,
        collection: options.collection
      }));
      this.zid = options.zid;
    }
});