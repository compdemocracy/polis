// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Handlebones = require("handlebones");
var template = require("../tmpl/profilePicView");
var Utils = require("../util/utils");


module.exports =  Handlebones.ModelView.extend({
  name: "profile-pic-view",
  tagName: "span",
  template: template,

  context: function() {
    var ctx = _.extend({}, Handlebones.ModelView.prototype.context.apply(this, arguments));
    ctx.pic = Utils.getAnonPicUrl();
    if (ctx.hasFacebook) {
      ctx.pic = ctx.facebook.fb_picture;
    }
    if (ctx.hasTwitter) {
      ctx.pic = ctx.twitter.profile_image_url_https;
    }
    if (ctx.hasXid) {
      ctx.pic = ctx.xInfo.x_profile_image_url;
    }
    if (window.preload.x_profile_image_url) {
      ctx.pic = window.preload.x_profile_image_url;
    }
    return ctx;
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model = options.model;
  }
});
