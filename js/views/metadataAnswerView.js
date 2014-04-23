var Handlebones = require("handlebones");
var template = require("../tmpl/metadataAnswer");


module.exports = Handlebones.ModelView.extend({
  name: "metadataAnswerView",
  template: template,
  allowDelete: false,
  initialize: function(options) {
      // this.model = options.model;
      this.zid = options.zid;
  }
});