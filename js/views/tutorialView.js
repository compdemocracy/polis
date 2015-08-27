var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/tutorial");
var utils = require("../util/utils");

var SECTIONS = {
  // Intro to Vis Tutorial
  A: {
    1: true,
    2: true,
    3: true
  },
  // Analyze Groups Tutorial
  B: {
    1: true
  }
};

var DONE_BUTTON_VISIBLE = {
  A: false,
  B: true
};

var SEEN;
function initSeen() {
  SEEN = {
    A: {},
    B: {}
  };
}
initSeen();

module.exports = Handlebones.ModelView.extend({
    name: "tutorial-view",
    template: template,
    events: {
      "click #nextTutorialStepButton": "next",
      "click #resetTutorial": "resetTutorial",
    },
  startAnalyzeTutorial: function() {
    var step = 1;
    var section = "B";
    while (SEEN[section][step]) {
      step++;
    }
    this.shouldFade = SECTIONS[section][step];
    this.model.set({
      section: section,
      step: step
    });
  },
  endAnalyzeTutorial: function() {
    this.model.set({
      section: "A",
      step: Infinity
    });
  },
  findNext: function() {
    return this.model.get("step") + 1;
  },
  next: function() {
    this.shouldFade = true;
    this.model.set("step", this.findNext());
  },
  resetTutorial: function() {
    this.shouldFade = true;
    initSeen();
    eb.trigger(eb.deselectGroups);
    this.model.set({
      section: "A",
      step: 1
    });
  },
  render: function() {
    var that = this;
    function doRender() {
      Handlebones.ModelView.prototype.render.apply(that, arguments);
    }

    if (this.shouldFade) {
      this.$el.fadeTo("fast", 0.001, function() {
        doRender();
        that.shouldFade = false;
        that.$el.fadeTo("fast", 1);
      });
    } else {
      doRender();
    }
    return this;
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    var section = ctx.section;
    var step = ctx.step;
    var currentSection = SECTIONS[section];
    if (currentSection && currentSection[step]) {
      ctx[section + "_step" + step] = true;
    } else {
      ctx.nostep = true;
    }
    SEEN[section][step] = true;
    ctx.showButton = true;
    if (!currentSection[step+1]) {
      ctx.showButton = DONE_BUTTON_VISIBLE[section];
    }
    ctx.nxtBtnTxt = currentSection[step+1] ? "Next tutorial step" : "Done";
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model.set("section", "A");
  }
});