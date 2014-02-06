define([
], function () {
  var bus = _.extend({}, Backbone.Events);

  bus.vote = "vote";
  bus.exit = "exit";
  bus.votableShown = "votableShown";

  return bus;
});
