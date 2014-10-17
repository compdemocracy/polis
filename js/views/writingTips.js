var template = require("../tmpl/writingTips");
var Handlebones = require("handlebones");

module.exports = Handlebones.View.extend({
  name: "writingTips",
  template: template
});