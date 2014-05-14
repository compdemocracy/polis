var Handlebones = require("handlebones");
var template = require("../tmpl/moderate-comment");

module.exports = Handlebones.ModelView.extend({
  name: "moderateCommentView",
  template: template,
  events: {
  	"click #accept": "accept",
  	"click #reject": "reject"
  },
  allowDelete: false,
  initialize: function(options) {
    // this.model = options.model;
    this.zid = options.zid;
  },
  accept: function() {
  	this.model.set({velocity: 1})
  	this.syncAndTrigger(this.model.get("velocity"));
  },
  reject: function() {
  	this.model.set({velocity: 0})
  	this.syncAndTrigger(this.model.get("velocity"));
  },
  syncAndTrigger: function(velocity) {
  	this.model.save()
  	this.parent.trigger("moderated", this.model, velocity)
  }
});