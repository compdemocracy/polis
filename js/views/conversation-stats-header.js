var eb = require("../eventBus");
var template = require("../tmpl/conversation-stats-header");
var Thorax = require("thorax");

module.exports = Thorax.View.extend({
  name: "conversation-stats-header-view",
  template: template,
  initialize: function(options) {
    var that = this;
    eb.on(eb.participantCount, function(count) {
      that.participantCount = count;
      that.render();
    });
    eb.on(eb.commentCount, function(count) {
      that.commentCount = count;
      that.render();
    });
    eb.on(eb.voteCount, function(count) {
      that.voteCount = count;
      that.render();
    });
  }
});

