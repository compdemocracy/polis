var template = require("../tmpl/empty-view");
var Handlebones = require("handlebones");

module.exports = Handlebones.View.extend({
  name: "emptyView",
  template: template
});