var template = require("../tmpl/metadataAnswer");
var View = require("../view");


module.exports = View.extend({
  name: "metadataAnswerView",
  template: template,
  allowDelete: false,
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});