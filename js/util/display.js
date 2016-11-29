// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


var $ = require("jquery");

function isVisible(tag) {
  return function() {
    // console.log("body > #" + tag);
    // console.log($("body > #" + tag).css("display"));
    return /block/.exec($("body > #" + tag).css('display'));
  };
}

function getWidth() {
  return $(document.body).width();
}

var widthCache = getWidth();

$(window).resize(function() {
  widthCache = getWidth();
});

function xs() {
  return widthCache <= window.xsThresh;
}

module.exports = {
  init: function() {
    var body = $(document.body);
    body.append("<span id='xs' class='visible-xs'></span>");
    body.append("<span id='sm' class='visible-sm'></span>");
    body.append("<span id='md' class='visible-md'></span>");
    body.append("<span id='lg' class='visible-lg'></span>");
  },
  xs: xs,
  sm: isVisible('sm'),
  md: isVisible('md'),
  lg: isVisible('lg'),
  getCachedWidth: function() {
    return widthCache;
  },
};

