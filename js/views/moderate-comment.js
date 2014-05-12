var Handlebones = require("handlebones");
var template = require("../tmpl/moderate-comment");

module.exports = Handlebones.ModelView.extend({
  name: "moderateCommentView",
  template: template,
  allowDelete: false,
  initialize: function(options) {
      // this.model = options.model;
      this.zid = options.zid;
  }
});