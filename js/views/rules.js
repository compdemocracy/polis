var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var template = require("../tmpl/rules");
var Handlebones = require("handlebones");
var RuleItemView = require("../views/rule-item");
var Handlebars = require("handlebars");
var rulesEmptyTemplate = require("../tmpl/rules-empty");

var CV = Handlebones.CollectionView.extend({
  tagName: "div",
  modelView: RuleItemView
});


var EV = Handlebones.View.extend({
  tagName: "p",
  template: rulesEmptyTemplate
});


module.exports = Handlebones.View.extend({
    name: "rulesView",
    template: template,
    allowCreate: false,
    CollectionView: CV,

    initialize: function(options) {
      this.rulesCollectionView = this.addChild(new this.CollectionView({
        emptyView: EV,
        modelView: RuleItemView,
        collection: options.collection
      }));
      this.conversation_id = options.conversation_id;
    }
});