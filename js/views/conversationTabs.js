var ChangeVotesView = require("../views/change-votes");
var CommentView = require('../views/vote-view');
var CommentFormView = require("../views/comment-form");
var ConversationStatsHeader = require('../views/conversation-stats-header');
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/conversationTabs");


module.exports =  Handlebones.ModelView.extend({
  name: "conversation-tabs-view",
  template: template,

  ANALYZE_TAB: "analyzeTab",
  METADATA_TAB: "metadata_pill",
  VOTE_TAB: "commentViewTab",
  WRITE_TAB: "commentFormTab",

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
    return c;
  },

  events: {
    "click .analyzeGroupCloseButton": function() {
      this.trigger("analyzeGroups:close");
    },
    // Before shown
    "show.bs.tab": function (e) {
      var to = e.target;
      var from = e.relatedTarget;
      this.currentTab = to.id;
      if (to && to.id === this.WRITE_TAB) {
        this.trigger("beforeshow:write");
      }
       // previous tab
      if (from && from.id === this.WRITE_TAB) {
        this.trigger("beforehide:write");
      }
      if(from && from.id === this.ANALYZE_TAB) {
        this.trigger("beforehide:analyze");
      }
      if(to && to.id === this.ANALYZE_TAB) {
        this.trigger("beforeshow:analyze");
      }
      if(to && to.id === this.VOTE_TAB) {
        this.trigger("beforeshow:vote");
      }
    },
    
    // After shown
    "shown.bs.tab": function (e) {
      console.log(e.target);
      // e.relatedTarget // previous tab
      if(e.target && e.target.id === this.ANALYZE_TAB) {
        this.trigger("aftershow:analyze");
      }
    }
  },

  doShowGroupUX: function() {
    this.model.set("showGroupHeader", true);
    this.model.set("showTabs", false);
  },
  doShowTabsUX: function() {
    this.model.set("showGroupHeader", false);
    this.model.set("showTabs", true);
  },
  onMetadataTab: function() {
    return this.currentTab === this.METADATA_TAB;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;

    // start with the vote tab
    this.currentTab = this.VOTE_TAB,

    eb.on(eb.clusterClicked, function(gid) {
      if (gid === -1) {
        that.doShowTabsUX();
      } else {
        that.doShowGroupUX();
      }
    });

  }
});
