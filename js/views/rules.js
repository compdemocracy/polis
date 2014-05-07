var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/rules");
var Handlebones = require("handlebones");
var RuleItemView = require("../views/rule-item");


var CV = Handlebones.CollectionView.extend({
  tagName: "div",
  modelView: RuleItemView
});


module.exports = Handlebones.View.extend({
    name: "rulesView",
    template: template,
    allowCreate: false,
    CollectionView: CV,

    initialize: function(options) {
      this.rulesCollectionView = this.addChild(new this.CollectionView({
        collection: options.collection
      }));
      this.zid = options.zid;
    }
});