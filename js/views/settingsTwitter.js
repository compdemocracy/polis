var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/settingsTwitter");
var URLs = require("../util/url");

var urlPrefix = URLs.urlPrefix;

module.exports = Handlebones.ModelView.extend({
  name: "settings",
  template: template,
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    if (ctx.screen_name) {
      ctx.screen_name_w_at = '@' + ctx.screen_name;
    }
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model = options.model;

  },
  events: {
  }
});