var template = require("../tmpl/conversationInfoSlideView");
var Handlebones = require("handlebones");
var eb = require("../eventBus");
var _ = require("underscore");


module.exports =  Handlebones.ModelView.extend({
  name: "conversationInfoSlideView",
  template: template,
  className: "conversationInfoSlideView",
  events: {
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
  }
});

