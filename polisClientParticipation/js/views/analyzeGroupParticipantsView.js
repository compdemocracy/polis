// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var template = require("../tmpl/analyzeGroupParticipantsView");
var Handlebones = require("handlebones");
var eb = require("../eventBus");


module.exports = Handlebones.View.extend({
  name: "analyzeGroupParticipants",
  template: template,
  events: {
  },
  context: function() {
    var ctx = Handlebones.View.prototype.context.apply(this, arguments);
    ctx.ptptoisLength = this.ptptois && this.ptptois.length;
    return ctx;
  },
  initialize: function(options) {
    var that = this;
    var getParticipantsOfInterestForGid = options.getParticipantsOfInterestForGid;
    var getGroupInfo = options.getGroupInfo;

    eb.on(eb.clusterClicked, function(gid) {
      if (_.isUndefined(gid)) {
        return;
      }
      if (gid < 0) {
        return;
      }
      that.ptptois = getParticipantsOfInterestForGid(gid);
      that.othersCount = (getGroupInfo(gid).count) - that.ptptois.length;
      that.ptptois = _.map(that.ptptois, function(x) {
        x.name = (x.twitter && (x.twitter.name || "@"+x.twitter.screen_name)) || (x.facebook && x.facebook.fb_name) || "";
        if (x.twitter && x.twitter.screen_name) {
          x.twitter_url = "https://twitter.com/" + x.twitter.screen_name;
        }
        if (x.facebook && (x.facebook.fb_user_id || x.facebook.fb_link)) {
          x.facebook_url = x.facebook.fb_link || ("https://www.facebook.com/app_scoped_user_id/" + x.facebook.fb_user_id);
        }
        // x.location = (x.twitter && x.twitter.location) || (x.facebook && x.facebook.location) || "";
        x.hasSocial = !!(x.twitter || x.facebook);
        return x;
      });
      that.render();
    });
  }
});
