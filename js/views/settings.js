var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/settings");


module.exports = Handlebones.ModelView.extend({
  name: "settings",
  template: template,
  initialize: function(options) {
    this.model = options.model;
  },
  events: {
  }
});