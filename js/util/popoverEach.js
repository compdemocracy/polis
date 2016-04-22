var $ = require("jquery");
var bootstrapToolTip = require("bootstrap_tooltip");
var bootstrapPopover = require("bootstrap_popover");

var originalPopover = $.fn.popover;
var popoverTargets = [];

$.fn.popover = function() {
  if (arguments[0] === "show") {
    popoverTargets.push(this);
  }
  return originalPopover.apply(this, arguments);
};

// Pass in a popover command, like "hide" or "destroy"
function each() {
  for (var i = 0; i < popoverTargets.length; i++) {
    var el = popoverTargets[i];
    el.popover.apply(el, arguments);
  }
}


module.exports = each;
