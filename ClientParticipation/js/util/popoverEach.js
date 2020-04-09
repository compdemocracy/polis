// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var $ = require("jquery");


// not sure about these
require("bootstrap_tooltip");
require("bootstrap_popover");


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
