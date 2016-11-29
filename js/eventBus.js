// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("underscore");
var Backbone = require("backbone");

var bus = _.extend({}, Backbone.Events);
bus.authNeeded = "authNeeded";
bus.backgroundClicked = "backgroundClicked";
bus.vote = "vote";
bus.exitConv = "exitConv";
bus.votableShown = "votableShown";
bus.clusterClicked = "clusterClicked";
bus.clusterSelectionChanged = "clusterSelectionChanged";
bus.commentSelected = "commentSelected";
bus.doneUsingWipCommentFormText = "doneUsingWipCommentFormText";
bus.participantCount = "participantCount";
bus.pidChange = "pidChange"; // PID_FLOW
bus.voteCount = "voteCount";
bus.commentCount = "commentCount";
bus.moderated = "moderated";
bus.moderatedPtpt = "moderatedPtpt";
bus.deselectGroups = "deselectGroups";
bus.interacted = "interacted"; // user has interacted (voted, written, changed tabs, etc)
bus.twitterConnected = "twitterConnected";
bus.twitterConnectedCommentForm = "twitterConnectedCommentForm";
bus.twitterConnectedParticipationView = "twitterConnectedParticipationView";
bus.twitterConnectedVoteView = "twitterConnectedVoteView";
bus.visShown = "visShown";
bus["beforehide:majority"] = "beforehide:majority";
bus["aftershow:majority"] = "aftershow:majority";
bus.firstRender = "firstRender";

module.exports = bus;