var template = require("../tmpl/metadataAnswerFilter");
var View = require("../view");

module.exports = View.extend({
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
    var that = this;
    this.model = options.model;
    this.zid = options.zid;
    this.model.set("disabled", false);
  }
});