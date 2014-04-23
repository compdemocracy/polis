var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/analyze-comment");
var CommentModel = require("../models/comment");

module.exports = Handlebones.ModelView.extend({
    name: "analyze-comment-view",
    template: template,
    events: {
      click: function() {
        eb.trigger(eb.commentSelected, this.model.get("tid"));
      },
      mouseover: function() {
        this.$(".query_result_item").addClass("hover");
      },
      mouseout: function() {
        this.$(".query_result_item").removeClass("hover");
      }
      // rendered: function() {
      // }
    }
});