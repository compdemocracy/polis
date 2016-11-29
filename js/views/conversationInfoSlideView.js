// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var template = require("../tmpl/conversationInfoSlideView");
var Handlebones = require("handlebones");
var Strings = require("../strings");

module.exports =  Handlebones.ModelView.extend({
  name: "conversationInfoSlideView",
  template: template,
  className: "conversationInfoSlideView infoArea",
  events: {
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx.twitterShareCount = preload.firstConv.twitterShareCount;
    ctx.fbShareCount = preload.firstConv.fbShareCount;
    ctx.s = Strings;
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
  }
});
