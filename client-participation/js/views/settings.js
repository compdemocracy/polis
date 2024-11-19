// var Backbone = require("backbone");
// var Handlebars = require("handlebars");
// var Handlebones = require("handlebones");
var PolisModelView = require("../lib/PolisModelView");
// var TwitterUserModel = require("../models/twitterUser");
var template = require("../templates/settings.handlebars");
// var SettingsTwitterView = require("./settingsTwitter");
// var URLs = require("../util/url");
// var urlPrefix = URLs.urlPrefix;

module.exports = PolisModelView.extend({
  name: "settings",
  template: template,
  context: function() {
    var ctx = PolisModelView.prototype.context.apply(this, arguments);
    // this.model.get("site_ids").push(35234); // keep this here for testing
    ctx.hasMultipleSites = this.model.get("site_ids").length > 1;
    // ctx.pageId = (Math.random() * 1e9) << 0;
    return ctx;
  },
  initialize: function(options) {
    this.model = options.model;

    // var twitterUserModel = new TwitterUserModel({});

    // twitterUserModel.fetch();

    // this.settingsTwitter = this.addChild(new SettingsTwitterView({
    //   model: twitterUserModel
    // }));
  },
  events: {
    "click #addSite": function() {
      $.get("/api/v3/dummyButton?button=addAnotherSiteIdFromSettings");
      alert("coming soon");
    }
  }
});
