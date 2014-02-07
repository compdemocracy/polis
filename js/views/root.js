var LayoutView = require("./layout-view");
var rootTemplate = require("./templates/root");

var RootView = LayoutView.extend({
  name: "root",
  template: rootTemplate
});
var instance;
RootView.getInstance = function(target) {
  if (!instance) {
    instance = new RootView();
    instance.appendTo(target || document.body);
  }
  return instance;
};

module.exports = RootView;