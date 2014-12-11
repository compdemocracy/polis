var ChangeVotesView = require("../views/change-votes");
var CommentView = require('../views/vote-view');
var CommentFormView = require("../views/comment-form");
var ConversationStatsHeader = require('../views/conversation-stats-header');
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var PolisFacebookUtils = require('../util/facebookButton');
var template = require("../tmpl/conversationTabs");
var display = require("../util/display");
var Utils = require("../util/utils");


module.exports =  Handlebones.ModelView.extend({
  name: "conversation-tabs-view",
  template: template,
  ANALYZE_TAB: "analyzeTab",
  GROUP_TAB: "groupTab",
  LEGEND_TAB: "legendTab",
  METADATA_TAB: "metadata_pill",
  VOTE_TAB: "commentViewTab",
  WRITE_TAB: "commentFormTab",
  from: {},

  gotoTab: function(id) {
    this.currentTab = id;
    this.$("#" + id).click();
  },
  gotoVoteTab: function() {
    this.gotoTab(this.VOTE_TAB);
  },
  gotoWriteTab: function() {
    this.gotoTab(this.WRITE_TAB);
  },
  gotoAnalyzeTab: function() {
    this.gotoTab(this.ANALYZE_TAB);
  },
  gotoGroupTab: function() {
    this.gotoTab(this.GROUP_TAB);
  },
  gotoLegendTab: function() {
    this.gotoTab(this.LEGEND_TAB);
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
    if (this.currentTab === this.ANALYZE_TAB) {
      c.analyzeActive = true;
    }
    if (this.currentTab === this.GROUP_TAB) {
      c.groupActive = true;
    }
    if (this.currentTab === this.LEGEND_TAB) {
      c.legendActive = true;
    }        
    if (display.xs()) {
      c.smallTabs = true;
    }
    c.use_background_content_class = display.xs();
    return c;
  },

  events: {
    "click #fbConnectBtn": "fbConnectBtn",

    // Before shown
    "show.bs.tab": function (e) {
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
      if(from && from.id === this.ANALYZE_TAB) {
        this.trigger("beforehide:analyze");
      }
      if(to && to.id === this.ANALYZE_TAB) {
        this.trigger("beforeshow:analyze");
      }

      if(from && from.id === this.GROUP_TAB) {
        this.trigger("beforehide:group");
        this.hideGroupHeader();
        this.showTabLabels();
      }
      if(to && to.id === this.GROUP_TAB) {
        this.trigger("beforeshow:group");
        this.showGroupHeader();
        this.hideTabLabels();
      }
      if(to && to.id === this.VOTE_TAB) {
        this.trigger("beforeshow:vote");
      }
    },
    
    // After shown
    "shown.bs.tab": function (e) {
      var to = e.target;
      // e.relatedTarget // previous tab
      if(e.target && e.target.id === this.ANALYZE_TAB) {
        this.trigger("aftershow:analyze");
      }
      if(e.target && e.target.id === this.GROUP_TAB) {
        this.trigger("aftershow:group");
      }
      if (e.target && e.target.id === this.WRITE_TAB) {
        this.trigger("aftershow:write");
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
    return this.ANALYZE_TAB === this.currentTab;
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
    var that = this;
    PolisFacebookUtils.connect().then(function() {
      // that.model.set("response", "fbdone");
      location.reload();
    }, function(err) {
      alert("facebook error");
    });
  },
  
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;

    // start with the vote tab
    this.currentTab = this.VOTE_TAB;

  }
});
