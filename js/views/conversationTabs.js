// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// var ConversationStatsHeader = require('../views/conversation-stats-header');
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var PolisFacebookUtils = require('../util/facebookButton');
var template = require("../tmpl/conversationTabs");
var display = require("../util/display");
var Utils = require("../util/utils");


module.exports = Handlebones.ModelView.extend({
  name: "conversation-tabs-view",
  template: template,
  MAJORITY_TAB: "majorityTab",
  GROUP_TAB: "groupTab",
  LEGEND_TAB: "legendTab",
  METADATA_TAB: "metadata_pill",
  VOTE_TAB: "commentViewTab",
  WRITE_TAB: "commentFormTab",
  INFOPANE_TAB: "infoPaneTab",
  from: {},

  gotoTab: function(id) {
    this.currentTab = id;
    this.$("#" + id).click();
  },
  gotoVoteTab: function() {
    this.gotoTab(this.VOTE_TAB);
    this.stopPulsingVoteTab();
  },
  gotoWriteTab: function() {
    this.gotoTab(this.WRITE_TAB);
    this.stopPulsingVoteTab();
  },
  gotoAnalyzeTab: function() {
    this.gotoTab(this.MAJORITY_TAB);
    this.maybeStartPulsingVoteTab();
  },
  gotoGroupTab: function() {
    this.gotoTab(this.GROUP_TAB);
    this.maybeStartPulsingVoteTab();
  },
  gotoLegendTab: function() {
    this.gotoTab(this.LEGEND_TAB);
    this.maybeStartPulsingVoteTab();
  },
  gotoInfoPaneTab: function() {
    this.gotoTab(this.INFOPANE_TAB);
  },
  hideLegend: function() {
    if (this.onLegendTab()) {
      this.gotoVoteTab(); // TODO should probably to to most recent tab
    }
  },
  toggleLegend: function() {
    if (this.onLegendTab()) {
      this.hideLegend();
    } else {
      this.gotoLegendTab();
    }
  },

  context: function() {
    var c = _.extend({}, Handlebones.ModelView.prototype.context.apply(this, arguments));
    if (this.currentTab === this.VOTE_TAB) {
      c.voteActive = true;
    }
    if (this.currentTab === this.WRITE_TAB) {
      c.writeActive = true;
    }
    if (this.currentTab === this.MAJORITY_TAB) {
      c.majorityActive = true;
    }
    if (this.currentTab === this.GROUP_TAB) {
      c.groupActive = true;
    }
    if (this.currentTab === this.LEGEND_TAB) {
      c.legendActive = true;
    }
    if (this.currentTab === this.INFOPANE_TAB) {
      c.infoPaneActive = true;
    }

    if (display.xs()) {
      c.smallTabs = true;
    }
    c.logoutDest = window.location.pathname + window.location.hash;
    c.use_background_content_class = display.xs();
    c.hasFacebook = userObject.hasFacebook;
    c.hasTwitter = userObject.hasTwitter;
    c.dropdownLabel = userObject.hname || "Login";
    c.showLogout = userObject.hasTwitter || userObject.hasFacebook || userObject.email;
    c.smallMenu = true; // don't show full name, etc as menu's button, just polis icon and caret
    c.showMajorityTab = this.showMajorityTab;
    c.selfUrl = null;
    if (Utils.isInIframe()) {
      c.selfUrl = (document.location + "").replace("embed.pol.is", "pol.is");
    }
    return c;
  },

  onAnalyzeTabClick: function() {
    this.maybeStartPulsingVoteTab();
  },

  onWriteTabClick: function() {
    this.stopPulsingVoteTab();
  },
  onVoteTabClick: function() {
    this.stopPulsingVoteTab();
  },
  onInfoPaneTabClick: function() {
    //
  },
  events: {
    "click #fbConnectBtn": "fbConnectBtn",
    "click #twitterConnectBtn": "twitterConnectBtn",
    "click #fbLoginBtn": "fbConnectBtn", // NOTE: may want a separate handler/API
    "click #twitterLoginBtn": "twitterConnectBtn", // NOTE: may want a separate handler/API
    "click #majorityTab": "onAnalyzeTabClick",
    "click #commentFormTab": "onWriteTabClick",
    "click #commentViewTab": "onVoteTabClick",
    "click #infoPaneTab": "onInfoPaneTabClick",
    // Before shown
    "show.bs.tab": function(e) {
      var to = e.target;
      var from = e.relatedTarget;
      // console.log("to", to.id);
      // console.log("from", from.id);
      this.currentTab = to.id;
      if (to && to.id === this.WRITE_TAB) {
        this.trigger("beforeshow:write");
      }
      if (to && to.id === this.LEGEND_TAB) {
        this.trigger("beforeshow:legend");
      }
      // previous tab
      if (from && from.id === this.WRITE_TAB) {
        this.trigger("beforehide:write");
      }
      if (from && from.id === this.LEGEND_TAB) {
        this.trigger("beforehide:legend");
      }
      if (from && from.id === this.MAJORITY_TAB) {
        this.trigger("beforehide:majority");
        eb.trigger("beforehide:majority");
      }
      if (to && to.id === this.MAJORITY_TAB) {
        this.trigger("beforeshow:majority");
      }

      if (from && from.id === this.GROUP_TAB) {
        this.trigger("beforehide:group");
        this.hideGroupHeader();
        this.showTabLabels();
      }
      if (to && to.id === this.GROUP_TAB) {
        this.trigger("beforeshow:group");
        this.showGroupHeader();
        this.hideTabLabels();
      }
      if (to && to.id === this.VOTE_TAB) {
        this.trigger("beforeshow:vote");
      }
    },
    // these aren't working
    // "hide.bs.tab": function(e) {
    //   debugger;
    // },
    // "hidden.bs.tab": function(e) {
    //   debugger;
    // },
    // After shown
    "shown.bs.tab": function(e) {
      var to = e.target;
      // e.relatedTarget // previous tab
      if (to && to.id === this.MAJORITY_TAB) {
        this.trigger("aftershow:majority");
        eb.trigger("aftershow:majority");
      }
      if (to && to.id === this.GROUP_TAB) {
        this.trigger("aftershow:group");
      }
      if (to && to.id === this.WRITE_TAB) {
        this.trigger("aftershow:write");
      }
      if (to && to.id === this.VOTE_TAB) {
        this.stopPulsingVoteTab();
        this.trigger("aftershow:vote");
      } else if (to && to.id === this.WRITE_TAB) {
        // don't pulse on write tab
        this.stopPulsingVoteTab();
      } else {
        // all other tabs cause pulsing
        this.maybeStartPulsingVoteTab();
      }
      // console.log("setting from", to);
      // this.from = to;
    }
  },

  showTabLabels: function() {
    this.model.set("showTabs", true);
  },
  hideTabLabels: function() {
    this.model.set("showTabs", false);
  },
  hideGroupHeader: function() {
    this.model.set("showGroupHeader", false);
  },
  showGroupHeader: function() {
    this.model.set("showGroupHeader", true);
  },
  onAnalyzeTab: function() {
    return this.MAJORITY_TAB === this.currentTab;
  },
  onVoteTab: function() {
    return this.VOTE_TAB === this.currentTab;
  },
  onGroupTab: function() {
    return this.GROUP_TAB === this.currentTab;
  },
  onLegendTab: function() {
    return this.LEGEND_TAB === this.currentTab;
  },

  fbConnectBtn: function() {
    PolisFacebookUtils.connect().then(function() {
      // that.model.set("response", "fbdone");
      location.reload();
    }, function(err) {
      // alert("facebook error");
    });
  },

  twitterConnectBtn: function() {
    // window.top.postMessage("twitterConnectBegin", "*");


    // open a new window where the twitter auth screen will show.
    // that window will redirect back to a simple page that calls window.opener.twitterStatus("ok")
    var params = 'location=0,status=0,width=800,height=400';
    window.open(document.location.origin + "/api/v3/twitterBtn?dest=/twitterAuthReturn", 'twitterWindow', params);


    // var dest = window.location.pathname + window.location.hash;
    // window.location = "/api/v3/twitterBtn?dest=" + dest;
  },
  stopPulsingVoteTab: function() {
    this.$("#voteTab").removeClass("pulseEffect");
  },
  maybeStartPulsingVoteTab: function() {
    if (this.serverClient.unvotedCommentsExist()) {
      // setTimeout is a workaround since the classes seem to get cleared, probably by Boostrap Tabs code.
      setTimeout(function() {
        $("#voteTab").addClass("pulseEffect");
      }, 100);
    }
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;

    eb.on(eb.visShown, function() {
      $("#majorityTab").fadeIn();
      that.showMajorityTab = true;
    });
    this.currentTab = this.WRITE_TAB;
    if (options.openToWriteTab) {

      // TODO ugly flash, fix later
      setTimeout(function() {
        that.gotoTab(that.WRITE_TAB);
      });
    }
    // else if (options.openToAnalyzeTab) {

    //   // TODO ugly flash, fix later
    //   // setTimeout(function() {
    //     that.gotoAnalyzeTab();
    //   // },1000);
    // }
    this.serverClient = options.serverClient;

    eb.on("clusterClicked", function(gid) {
      if (gid >= 0) {
        that.maybeStartPulsingVoteTab();
      } else {
        that.stopPulsingVoteTab();
      }
    });

  }
});
