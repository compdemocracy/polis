var display = require("../util/display");
var template = require("../tmpl/analyzeGroupParticipantsView");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");
var eb = require("../eventBus");


module.exports = Handlebones.View.extend({
  name: "analyzeGroupParticipants",
  template: template,
  events: {
  },
  initialize: function(options) {
    var that = this;
    var getParticipantsOfInterestForGid = options.getParticipantsOfInterestForGid;

    eb.on(eb.clusterClicked, function(gid) {

      that.ptptois = getParticipantsOfInterestForGid(gid);
      that.ptptois = _.map(that.ptptois, function(x) {
        x.name = (x.twitter && ("@"+x.twitter.screen_name)) || (x.facebook && x.facebook.fb_name) || "";
        x.location = (x.twitter && x.twitter.location) || (x.facebook && x.facebook.location) || "";
        x.hasSocial = !!(x.twitter || x.facebook);
        return x;
      })
      that.render();
    });
  }
});
