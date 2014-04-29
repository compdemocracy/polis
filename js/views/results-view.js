var View = require("handlebones").View;
var template = require("../tmpl/results-view");

module.exports = View.extend({
  name: "resultsView",
  template: template
});