var MetadataAnswerView = require("../views/metadataAnswerView");
var template = require("../tmpl/metadataQuestionAndAnswers");
var Handlebones = require("handlebones");

module.exports = Handlebones.ModelView.extend({
  name: "metadataQuestionAndAnswersView",
  template: template,
  allowCreate: false,
  allowDelete: false,
  // itemViewForCollection: MetadataAnswerView,

    context: function() {
      debugger;
      return this;
    },
    render:function() {
      debugger;
    },

  initialize: function(options) {
    debugger;
      // this.model = options.model; // question model
      this.answers = this.model.collection; // answers collection
      this.answersCollectionView = this.addChild(new Handlebones.CollectionView({
        modelView: MetadataAnswerView,
        collection: this.answers
      }));
      this.zid = options.zid;
  }
});