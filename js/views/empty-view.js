var template = require("../tmpl/empty-view");
var Handlebones = require("handlebones");
var PolisView = require("../lib/PolisView");

module.exports = PolisView.extend({
  name: "emptyView",
  template: template
});