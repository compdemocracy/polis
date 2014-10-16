var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/tutorial");
var utils = require("../util/utils");

var STEPS = {
  1: true,
  2: true,
  3: true,
};

module.exports = Handlebones.ModelView.extend({
    name: "tutorial-view",
    template: template,
    events: {
      "click #nextTutorialStepButton": "next",
      "click #resetTutorial": "resetTutorial",
    },
  next: function() {
    this.model.set("step", this.model.get("step") + 1);
  },
  resetTutorial: function() {
    this.model.set("step", 1);
  },
  render: function() {
    var that = this;
    this.$el.fadeTo("fast", 0.001, function() {
      Handlebones.ModelView.prototype.render.apply(that, arguments);
      that.$el.fadeTo("fast", 1);
    });
    return this;
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    if (STEPS[ctx.step]) {
      ctx["step" + ctx.step] = true;
    } else {
      ctx.nostep = true;
    }
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
  }
});