var AnalyzeCommentView = require("../views/analyze-comment");

module.exports = AnalyzeCommentView.extend({
  initialize: function() {
    AnalyzeCommentView.prototype.initialize.apply(this, arguments);
    this.showCheckbox = true;
  }
});