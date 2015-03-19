var template = require("../tmpl/tutorialSlides");
var display = require("../util/display");
var PolisModelView = require("../lib/PolisModelView");
var Utils = require("../util/utils");

var LAST_STEP = 9;

module.exports =  PolisModelView.extend({
  name: "tutorialSlidesView",
  template: template,
  context: function() {
    var c = PolisModelView.prototype.context.apply(this, arguments);
    // c.use_background_content_class = display.xs();

    // var step = 2;
    c["step" + c.step] = true;
    c.leftArrow = true;
    c.rightArrow = true;
    if (c.step <= 1) {
      c.leftArrow = false;
    }
    if (c.step > LAST_STEP) {
      c.rightArrow = false;
    }
    return c;
  },

  events: {
    "click .tutLeft": function(e){
      this.model.set("step", Math.max(0, this.model.get("step") - 1));
    },
    "click .tutRight": function(e){
      if (this.model.get("step") >= LAST_STEP) {
        this.trigger("done");
      } else {
        this.model.set("step", Math.min(LAST_STEP, this.model.get("step") + 1));
      }
    },
  },

  initialize: function(options) {
    PolisModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    if (this.model.get("step") > LAST_STEP) {
      setTimeout(function() {

        that.trigger("done");
      }, 10);
    }
  }
});
