var AnalyzeCollectionView = require("../views/analyze-global-collection-view");
var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");

var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var SHOULD_AUTO_CLICK_FIRST_COMMENT = false;


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



module.exports = Handlebones.View.extend({
    name: "analyze-global-view",
    CV: AnalyzeCollectionView,
    template: template,
    tidsForGroup: null,
    events: {
      "click #sortAgree": "sortAgree",
      "click #sortDisagree": "sortDisagree",
      "click #sortDivisive": "sortDivisive",
      "keyup input": "updateSearch",
      "propertychange input": "updateSearch",
      submit: function(e) {
        e.preventDefault();
      },
      // "rendered:collection": function() {
      //   this.selectFirst();
      //   console.log('rendered:collection');
      // },
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
    selectSortModes: function(chosenButtonSelector) {
      this.$("#sortAgree,#sortDisagree,#sortDivisive").removeClass("enabled");
      this.$(chosenButtonSelector).addClass("enabled");
    },
    selectFirst: function() {
      if (this.analyzeCollectionView) {
        this.analyzeCollectionView.selectFirst();
      }
    },
  searchEnabled: true,
  sortEnabled: true,

  groupInfo: function() {
    return this.parent.groupInfo();
  },

  // sort with the current comparator
  sort: function() {
    this.collection.sort();
    if (SHOULD_AUTO_CLICK_FIRST_COMMENT) {
      this.selectFirst();
    }
  },
  sortAgree: function(e) {
    if (this.analyzeCollectionView) {
      this.analyzeCollectionView.groupMode = false;
    }
    this.collection.comparator = comparatorAgree;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortAgree");
  },
  sortDisagree: function(e) {
    if (this.analyzeCollectionView) {
      this.analyzeCollectionView.groupMode = false;
    }
    this.collection.comparator = comparatorDisagree;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortDisagree");
  },
  sortDivisive: function(e) {
    if (this.analyzeCollectionView) {
      this.analyzeCollectionView.groupMode = false;
    }
    this.collection.comparator = comparatorDivisive;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortDivisive");
  },
  sortRepness: function(e) {
    if (this.analyzeCollectionView) {
      this.analyzeCollectionView.groupMode = true;
    }
    // There are no buttons associated with this.
    this.collection.comparator = sortRepness;
    this.collection.sort();
    // this.selectFirst();
  },
  useCarousel: function() {
    return false;
    // return true;
    // return !Utils.isIE8() && display.xs();
  },
  hideCarousel: function() {
    this.$("#commentListView").show();
    this.$("#carousel").hide();
  },
  showCarousel: function() {
    this.$("#commentListView").hide();
    this.$("#carousel").show();
  },
  updateSearch: function(e) {
    this.searchString = e.target.value;
    this.deselectComments();
    if (this.analyzeCollectionView) {
      this.analyzeCollectionView.updateModelFilter();
    }
    // this.selectFirst();
  },
  deselectComments: function() {
    eb.trigger(eb.commentSelected, false);
  },
  
  initialize: function(options) {
    var that = this;
    this.collection = options.collection;
    this.collection.comparator = comparatorAgree;
    
    if (!that.useCarousel()) {
      this.analyzeCollectionView = this.addChild(new this.CV({
        collection: this.collection,
        comparator: comparatorAgree
      }));
    }

    var getTidsForGroup = options.getTidsForGroup;

    this.fetcher = options.fetcher;


    // TODO MOVE THIS LOGIC TO THE GROUP-SPECIFIC CODE...
    // this is getting crappy.

    function doFetch(gid) {
      that.collection.firstFetchPromise.then(function() {
        if (gid === -1) {
          that.$("#commentSearch").show();
          that.$("#commentSort").show();
          // that.$("#groupStats").hide();
          that.sortEnabled = true;
          that.searchEnabled = true;
          that.tidsForGroup = null;
          that.sortAgree();     
          if (this.analyzeCollectionView) {
            that.analyzeCollectionView.updateModelFilter();
          }
          // that.selectFirst();
        } else {
          that.$("#commentSearch").hide();
          that.$("#commentSort").hide();
          // that.$("#groupStats").show();
          that.sortEnabled = false;
          that.searchEnabled = false;
          getTidsForGroup(gid, NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW).then(function(o) {

            if (that.analyzeCollectionView) {
              that.analyzeCollectionView.groupMode = true;
            }
            that.tidsForGroup = o.tids;
            that.collection.updateRepness(o.tidToR);
            that.sortRepness();
            if (that.analyzeCollectionView) {
              that.analyzeCollectionView.updateModelFilter();
            }
            // that.selectFirst();
          });
        }
      });
    } // End doFetch

  }
});
