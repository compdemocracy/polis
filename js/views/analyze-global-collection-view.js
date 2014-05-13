var AnalyzeCommentView = require("../views/analyze-comment");
var eb = require("../eventBus");
var Handlebones = require("handlebones");



module.exports = Handlebones.CollectionView.extend({
  modelView: AnalyzeCommentView,
  visibleTids: [],
  modelFilter: function(model, index) {
    var searchString = this.parent.searchString;
    var visibleTids = this.visibleTids;
    var tidsForGroup = this.parent.tidsForGroup;
    var searchEnabled = this.parent.searchEnabled;
    var tid = model.get("tid");
    var hadTid= visibleTids.indexOf(tid) >= 0;


    if (tidsForGroup && tidsForGroup.indexOf(tid) === -1) {
      visibleTids = _.without(visibleTids, tid);
      if (hadTid) {
        this.parent.shouldNotifyForFilterChange = true; // TODO needed?
      }
      return false;
    }
    if (!_.isString(searchString) || /^\s*$/.exec(searchString)) {
      if (!hadTid) {
        this.parent.trigger("searchChanged", visibleTids);
      }
      visibleTids = _.union(visibleTids, [tid]);
      return true;
    }
    searchString = searchString
      .replace(/\s+/g, " ")
      .replace(/\s+$/,"")
      .replace(/^\s+/,"");

    var isMatch = true;
    if (searchEnabled) {
      if (_.isString(searchString)) {
        var tokens = searchString.split(/\s+/);
        // match all space separated word fragments
        var txt = model.get("txt").toLowerCase();
        for (var i = 0; i < tokens.length; i++) {
          var token = tokens[i].toLowerCase();

          var shouldNegateToken = token[0] === "-";
          if (shouldNegateToken) {
            token = token.slice(1);
          }
          var tokenPresent = txt.indexOf(token) >= 0;
          if (!token.length) {
            // a "-" followed by nothing should not count as present.
            tokenPresent = false;
          }
          if (
            (!tokenPresent && !shouldNegateToken) ||
            (tokenPresent && shouldNegateToken)) {
            isMatch = false;
            break;
          }
        }
      }
    }
    var doTrigger = false;
    if (isMatch) {
      visibleTids = _.union(visibleTids, [model.get("tid")]);
      if (!hadTid) {
        doTrigger = true;
      }
    } else {
      visibleTids = _.without(visibleTids, model.get("tid"));
      if (hadTid) {
        doTrigger = true;
      }
    }
    if (doTrigger) {
      this.parent.trigger("searchChanged", visibleTids);
    }
    return isMatch;
  },
  selectFirst: function() {
    var first = this.collection.first();
    if (first) {
      eb.trigger(eb.commentSelected, first.get("tid"));
    }
  },

  initialize: function() {
    var that = this;
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);

    eb.on(eb.commentSelected, function(tid) {
      that.collection.each(function(model) {
        if (model.get("tid") === tid) {
          model.set("selected", true);
        } else {
          model.set("selected", false);
        }
      });
    });

  }
});