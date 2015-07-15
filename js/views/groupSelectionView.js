var display = require("../util/display");
var template = require("../tmpl/groupSelectionView");
var Handlebones = require("handlebones");
var eb = require("../eventBus");
var _ = require("underscore");


module.exports =  Handlebones.ModelView.extend({
  name: "groupSelectionView",
  template: template,
  className: "groupSelectionView",
  events: {
    "click .groupButton": "onClick",
    "click .infoPaneButton": "onClickInfoPaneButton",
  },
  onClick: function(e) {
  	var $target = $(e.target);
  	var gid = Number($target.data("gid"));
  	if (_.isNumber(gid)) {
	  	this.model.set("selectedGid", gid);
	  	this.onChangedCallbacks.fire(gid);
  	}
  },
  onClickInfoPaneButton: function(e) {
    this.onClickInfoPaneButtonClickedCallbacks.fire();
    this.model.set("infoSlidePaneViewActive", true);
  },
  gotoInfoPaneTab: function() {
    this.model.set("infoSlidePaneViewActive", true);
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
  addInfoPaneButtonClickedListener: function(f) {
    this.onClickInfoPaneButtonClickedCallbacks.add(f);
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    var infoSlidePaneViewActive = ctx.infoSlidePaneViewActive;
    ctx.groups2 = ctx.groups.map(function(g) {
    	g = $.extend({}, g);
    	if (g.gid === ctx.selectedGid && !infoSlidePaneViewActive) {
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
    this.onClickInfoPaneButtonClickedCallbacks = $.Callbacks();
  }
});

