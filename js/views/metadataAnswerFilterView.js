var Handlebones = require("handlebones");
var template = require("../tmpl/metadataAnswerFilter");

module.exports = Handlebones.ModelView.extend({
  name: "metadataAnswerFilterView",
  template: template,
  tagName: "li",
  className: "nobullets",
  allowDelete: false,
  events: {
    "click .on": "disable",
    "click .off": "enable"
  },
  enable: function(e) {
    this.model.set("disabled", false);
  },
  disable: function(e) {
    this.model.set("disabled", true);
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    this.model = options.model;
    this.conversation_id = options.conversation_id;
    this.model.set("disabled", false);
  }
});