var display = require("../util/display");
var template = require("../tmpl/legend");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");


module.exports = Handlebones.View.extend({
  name: "legend-view",
  template: template,
  events: {
    // "click #sortAgree": "sortAgree",
    // "click #sortDisagree": "sortDisagree",
    // "click #sortDivisive": "sortDivisive",
    // "keyup input": "updateSearch",
    // "propertychange input": "updateSearch",
    rendered: function() {
      // var that = this;
      // var items = this.$(".query_result_item");
      // items.on("mouseover", function() {
      //     $(this).addClass("hover");
      // });
      // items.on("mouseout", function() {
      //     $(this).removeClass("hover");
      // });
    }
  },

  initialize: function(options) {
    var that = this;
  }
});
