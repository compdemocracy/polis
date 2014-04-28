var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/conversationTabs");

module.exports =  Handlebones.ModelView.extend({
  name: "conversation-tabs-view",
  template: template,
  events: {
  },

  doShowGroupUX: function() {
    this.model.set("showGroupHeader", true);
    this.model.set("showTabs", false);
  },
  doShowTabsUX: function() {
    this.model.set("showGroupHeader", false);
    this.model.set("showTabs", true);
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;

    eb.on(eb.clusterClicked, function(gid) {
      if (gid === -1) {
        that.doShowTabsUX();
      } else {
        that.doShowGroupUX();
      }
    });

  }
});
