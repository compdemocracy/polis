var AnalyzeCommentView = require("../views/analyze-comment");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Thorax = require("thorax");

var sortRepness = function(a, b) {
  return b.get("repness") - a.get("repness");
};

var sortMostAgrees = function(a, b) {
  return b.get("A") - a.get("A");
};

module.exports = Thorax.CollectionView.extend({
    name: "analyze-global-view",
    template: template,
    itemView: AnalyzeCommentView,
    visibleTids: null,
    events: {
      rendered: function() {
        var that = this;
        var items = this.$(".query_result_item");
        items.on("mouseover", function() {
            $(this).addClass("hover");
        });
        items.on("mouseout", function() {
            $(this).removeClass("hover");
        });
      }
    },
    itemFilter: function(model, index) {
      if (this.visibleTids && this.visibleTids.indexOf(model.get("tid")) === -1) {
        return false;
      }
      return true;
    },
  initialize: function(options) {
    var that = this;

    var getTidsForGroup = options.getTidsForGroup;

    this.fetcher = options.fetcher;
    this.collection.comparator = sortMostAgrees;
    
    eb.on(eb.commentSelected, function(tid) {
      that.collection.each(function(model) {
        if (model.get("tid") === tid) {
          model.set("selected", true);
        } else {
          model.set("selected", false);
        }
      });
    });

    
    eb.on(eb.clusterClicked, function(gid) {
      if (gid === false) {
        that.visibleTids = null;
        that.updateFilter();
        that.collection.comparator = sortMostAgrees;
        that.collection.sort();        
      } else {
        var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 3;
        getTidsForGroup(gid, NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW).then(function(o) {
          that.visibleTids = o.tids;
          that.collection.updateRepness(o.tidToR);
          that.updateFilter();
          that.collection.comparator = sortRepness;
          that.collection.sort();
        });
      }
    });
  }
});