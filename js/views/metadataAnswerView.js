var template = require("./templates/metadataAnswer");
var View = require("./view");

modules.exports = View.extend({
  name: "metadataAnswerView",
  template: template,
  allowDelete: false,
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});