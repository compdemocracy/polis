var _ = require("underscore");
var Backbone = require("Backbone")

var bus = _.extend({}, Backbone.Events);
bus.vote = "vote";
bus.exit = "exit";
bus.votableShown = "votableShown";

module.exports = bus;