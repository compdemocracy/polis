var _ = require("underscore");
var Backbone = require("backbone")

console.log('initalizing bus')

var bus = _.extend({}, Backbone.Events);
bus.vote = "vote";
bus.exitConv = "exitConv";
bus.votableShown = "votableShown";
bus.clusterClicked = "clusterClicked";
bus.clusterSelectionChanged = "clusterSelectionChanged";
bus.commentSelected = "commentSelected";
bus.participantCount = "participantCount";
bus.voteCount = "voteCount";
bus.commentCount = "commentCount";
bus.moderated = "moderated";
bus.moderatedPtpt = "moderatedPtpt";
bus.deselectGroups = "deselectGroups";
bus["beforehide:analyze"] = "beforehide:analyze";
bus["aftershow:analyze"] = "aftershow:analyze";

module.exports = bus;