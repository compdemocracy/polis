var template = require("../tmpl/groupSelectionView");
var Handlebones = require("handlebones");
var eb = require("../eventBus");
var _ = require("underscore");


module.exports =  Handlebones.ModelView.extend({
  name: "groupSelectionView",
  template: template,
  className: "groupSelectionView",
  events: {
    "click .groupButton": "onClick"
  },
  onClick: function(e) {
  	var $target = $(e.target);
  	var gid = Number($target.data("gid"));
  	if (_.isNumber(gid)) {
	  	this.model.set("selectedGid", gid);
	  	this.onChangedCallbacks.fire(gid);
  	}
  },
  show: function() {
  	this.model.set("visible", true);
  },
  setSelectedGroup: function(gid) {
  	this.gid = gid;
  },
  addSelectionChangedListener: function(f) {
  	this.onChangedCallbacks.add(f);
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx.groups2 = ctx.groups.map(function(g) {
    	g = $.extend({}, g);
    	if (g.gid === ctx.selectedGid) {
    		g.selected = true;
    	}
    	return g;
    });
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    this.onChangedCallbacks = $.Callbacks();
  }
});

