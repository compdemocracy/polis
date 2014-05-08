var AnalyzeCommentView = require("../views/analyze-comment");
var eb = require("../eventBus");
var Handlebones = require("handlebones");



function bbCompare(propertyName, a, b) {
  var x = b.get(propertyName) - a.get(propertyName);
  return x;
}
function bbCompareAscending(propertyName, a, b) {
  return -bbCompare(propertyName, a, b);
}
function compareTieBreaker(a, b) {
  var x = bbCompare("stars", a, b);
  x = x || a.get("txt").length - b.get("txt").length; // shorter comments first
  x = x || bbCompare("created", a, b);
  // x = x || (b.get("txt").toLowerCase() < a.get("txt").toLowerCase()) ? 1 : -1; // alphabetic
  return x;
}
function sortRepness(a, b) {
  var x = bbCompare("repness", a, b);
  return x || compareTieBreaker(a, b);
}
function comparatorAgree(a, b) {
  var x = bbCompare("A", a, b);
  x = x || bbCompareAscending("D", a, b);
  return x || compareTieBreaker(a, b);
}
function comparatorDisagree(a, b) {
  var x = bbCompare("D", a, b);
  x = x || bbCompareAscending("A", a, b);
  return x || compareTieBreaker(a, b);
}
function comparatorDivisive(a, b) {
  var b_agrees = b.get("A");
  var b_disagrees = b.get("D");
  var a_agrees = a.get("A");
  var a_disagrees = a.get("D");
  var b_product = b_agrees * b_disagrees;
  var a_product = a_agrees * a_disagrees;
  var b_sum = b_agrees + b_disagrees + 1; // Add 1 to prevent divide-by-zero
  var a_sum = a_agrees + a_disagrees + 1; // Add 1 to prevent divide-by-zero
  var x = b_product/b_sum - a_product/a_sum;
  x = x || bbCompareAscending("A", a, b);
  return x || compareTieBreaker(a, b);
}

function comparatorStars(a, b) {
  var x = bbCompare("stars", a, b);
  return x || compareTieBreaker(a, b);
}



module.exports = Handlebones.CollectionView.extend({
  modelView: AnalyzeCommentView,
  comparator: comparatorAgree,
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

  sortAgree: function(e) {
    this.collection.comparator = comparatorAgree;
    this.collection.sort();
    this.selectFirst();
  },
  sortDisagree: function(e) {
    this.collection.comparator = comparatorDisagree;
    this.collection.sort();
    this.selectFirst();
  },
  sortDivisive: function(e) {
    this.collection.comparator = comparatorDivisive;
    this.collection.sort();
    this.selectFirst();
  },
  sortRepness: function(e) {
    // There are no buttons associated with this.
    this.collection.comparator = sortRepness;
    this.collection.sort();
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
    this.collection.comparator = comparatorAgree;

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