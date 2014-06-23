var AnalyzeCommentView = require("../views/analyze-comment");
var Handlebones = require("handlebones");
var MetadataQuestionAndAnswersFilterView = require("../views/metadataQuestionAndAnswersFilterView");
var template = require("../tmpl/rule-item");


module.exports = Handlebones.ModelView.extend({
  name: "ruleItemView",
  template: template,
  allowDelete: false,
  initialize: function(options) {
    var model = this.model = options.model;
    // this.sid = options.sid;
    if (model.data instanceof MetadataQuestion) {
      this.itemView = new MetadataQuestionAndAnswersFilterView({
        model: model.data
      });
    }
    else if (model.data instanceof Comment) {
      this.itemView = new AnalyzeCommentView({
        model: model.data
      });
    }

  }
});