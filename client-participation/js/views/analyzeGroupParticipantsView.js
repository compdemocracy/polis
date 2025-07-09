// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("lodash");
var Handlebones = require("handlebones");
var eb = require("../eventBus");
var template = require("../templates/analyzeGroupParticipantsView.handlebars");

module.exports = Handlebones.View.extend({
  name: "analyzeGroupParticipants",
  template: template,
  events: {},
  context: function () {
    var ctx = Handlebones.View.prototype.context.apply(this, arguments);
    ctx.ptptoisLength = this.ptptois && this.ptptois.length;
    return ctx;
  },
  initialize: function (options) {
    var that = this;
    var getParticipantsOfInterestForGid = options.getParticipantsOfInterestForGid;
    var getGroupInfo = options.getGroupInfo;

    eb.on(eb.clusterClicked, function (gid) {
      if (_.isUndefined(gid)) {
        return;
      }
      if (gid < 0) {
        return;
      }
      that.ptptois = getParticipantsOfInterestForGid(gid);
      that.othersCount = getGroupInfo(gid).count - that.ptptois.length;
      that.ptptois = _.map(that.ptptois, function (x) {
        x.name = "";
        x.hasSocial = false;
        return x;
      });
      that.render();
    });
  }
});
