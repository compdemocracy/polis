var _ = require("underscore");
var Backbone = require("backbone")

var bus = _.extend({}, Backbone.Events);
bus.vote = "vote";
bus.exit = "exit";
bus.votableShown = "votableShown";

module.exports = bus;