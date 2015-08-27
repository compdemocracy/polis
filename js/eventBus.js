var _ = require("underscore");
var Backbone = require("backbone");

var bus = _.extend({}, Backbone.Events);
bus.backgroundClicked = "backgroundClicked";
bus.vote = "vote";
bus.exitConv = "exitConv";
bus.votableShown = "votableShown";
bus.clusterClicked = "clusterClicked";
bus.clusterSelectionChanged = "clusterSelectionChanged";
bus.commentSelected = "commentSelected";
bus.doneUsingWipCommentFormText = "doneUsingWipCommentFormText";
bus.participantCount = "participantCount";
bus.voteCount = "voteCount";
bus.commentCount = "commentCount";
bus.moderated = "moderated";
bus.moderatedPtpt = "moderatedPtpt";
bus.deselectGroups = "deselectGroups";
bus.interacted = "interacted"; // user has interacted (voted, written, changed tabs, etc)
bus.twitterConnected = "twitterConnected";
bus.visShown = "visShown";
bus["beforehide:majority"] = "beforehide:majority";
bus["aftershow:majority"] = "aftershow:majority";
bus.firstRender = "firstRender";

module.exports = bus;