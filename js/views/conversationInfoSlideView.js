var template = require("../tmpl/conversationInfoSlideView");
var Handlebones = require("handlebones");
var Strings = require("../strings");

module.exports =  Handlebones.ModelView.extend({
  name: "conversationInfoSlideView",
  template: template,
  className: "conversationInfoSlideView infoArea",
  events: {
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx.twitterShareCount = preload.firstConv.twitterShareCount;
    ctx.fbShareCount = preload.firstConv.fbShareCount;
    ctx.s = Strings;
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
  }
});
