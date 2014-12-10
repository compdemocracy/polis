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
    var getGroup = options.getGroup;

    eb.on(eb.clusterClicked, function(gid) {

      if (gid < 0) {
        return;
      }
      that.ptptois = getParticipantsOfInterestForGid(gid);
      var numBucketsThatAreNotPeople = 1; // don't count the anonbucket in the cluster
      that.othersCount = (getGroup(gid).length - numBucketsThatAreNotPeople) - that.ptptois.length; 
      that.ptptois = _.map(that.ptptois, function(x) {
        x.name = (x.twitter && (x.twitter.name || "@"+x.twitter.screen_name)) || (x.facebook && x.facebook.fb_name) || "";
        // x.location = (x.twitter && x.twitter.location) || (x.facebook && x.facebook.location) || "";
        x.hasSocial = !!(x.twitter || x.facebook);
        return x;
      })
      that.render();
    });
  }
});
