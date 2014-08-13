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
        this.model.trigger("change", this.model);
      },
      "click .exploreCheckbox": function() {
        this.model.set("unchecked", !this.model.get("unchecked"));
      },
      mouseover: function() {
        this.$(".query_result_item").addClass("hover");
      },
      mouseout: function() {
        this.$(".query_result_item").removeClass("hover");
      }
      // rendered: function() {
      // }
    },
    isSelected: function() {
      return this.selectedTid === this.model.get("tid");
    },
    context: function() {
      var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
      ctx.groupMode = this.parent.groupMode;
      var groupInfo = this.parent.groupInfo();
      ctx.gTotal = groupInfo.count;
      var tidInfo = groupInfo.votes[ctx.tid];
      ctx.gA_total = tidInfo && tidInfo.gA_total;
      ctx.gPercent = (ctx.gA_total / ctx.gTotal * 100) >> 0;
      ctx.selected = this.isSelected();
      return ctx;
    },
    initialize: function(isSelected) {
      var x = Handlebones.ModelView.prototype.initialize.apply(this, arguments);
      var that = this;
      // kind of crappy, but rather than have a 'selected' attribute on the model, just keep track of what is selected, and compute 'selected' at render time.
      eb.on(eb.commentSelected, function(tid) {
        var wasSelected = that.isSelected();
        var shouldRender = false;
        if (wasSelected && tid !== that.selectedTid) {
          // no longer selected, make sure we render.
          shouldRender = true;
        }
        that.selectedTid = tid;
        if (shouldRender) {
          that.model.trigger("change", that.model);
        }
      });

      return x;
    }
});