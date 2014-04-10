var template = require("../tmpl/empty-view");
var Thorax = require("thorax");

module.exports = Thorax.View.extend({
  name: "emptyView",
  template: template
});