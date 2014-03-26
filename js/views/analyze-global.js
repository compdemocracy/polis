var AnalyzeCommentView = require("../views/analyze-comment");
var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Thorax = require("thorax");


var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var sortRepness = function(a, b) {
  return b.get("repness") - a.get("repness");
};

var sortMostAgrees = function(a, b) {
  return b.get("A") - a.get("A");
};
var sortMostDisagrees = function(a, b) {
  return b.get("D") - a.get("D");
};

var sortMostStars = function(a, b) {
  return b.get("stars") - a.get("stars");
};
var el_carouselSelector = "#carousel";

module.exports = Thorax.CollectionView.extend({
    name: "analyze-global-view",
    template: template,
    itemView: AnalyzeCommentView,
    visibleTids: null,
    events: {
      "click #sortStar": "sortStar",
      "click #sortAgree": "sortAgree",
      "click #sortDisagree": "sortDisagree",
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
      this.$("#sortAgree,#sortDisagree,#sortStar").removeClass("enabled");
      this.$(chosenButtonSelector).addClass("enabled");
    },
    selectFirst: function() {
      var first = this.collection.first();
      if (first) {
        eb.trigger(eb.commentSelected, first.get("tid"));
      }
    },
    itemFilter: function(model, index) {
      var searchString = this.searchString;
      if (!_.isString(searchString) || /^\s*$/.exec(searchString)) {
        return true;
      }
      searchString = searchString
        .replace(/\s+/g, " ")
        .replace(/\s+$/,"")
        .replace(/^\s+/,"");

      if (this.visibleTids && this.visibleTids.indexOf(model.get("tid")) === -1) {
        return false;
      }
      var isMatch = true;
      if (this.searchEnabled) {
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
      return isMatch;
    },
  searchEnabled: true,
  sortEnabled: true,
  sortAgree: function(e) {
    this.collection.comparator = sortMostAgrees;
    this.collection.sort();
    this.selectFirst();
    this.selectSortModes("#sortAgree");
  },
  sortDisagree: function(e) {
    this.collection.comparator = sortMostDisagrees;
    this.collection.sort();
    this.selectFirst();
    this.selectSortModes("#sortDisagree");
  },
  sortStar: function(e) {
    alert("coming soon!");
  },

  sortRepness: function(e) {
    // There are no buttons associated with this.
    this.collection.comparator = sortRepness;
    this.collection.sort();
  },
  useCarousel: function() {
      return !this.isIE8 && display.xs();
  },
  hideCarousel: function() {
    this.$("#carousel").hide();
  },
  showCarousel: function() {
    this.$("#carousel").show();
  },
  updateSearch: function(e) {
    this.searchString = e.target.value;
    this.deselectComments();
    this.updateFilter();
    // this.selectFirst();
  },
  deselectComments: function() {
    eb.trigger(eb.commentSelected, false);
  },
  renderWithCarousel: function() {

    $(el_carouselSelector).html("");
    // $(el_carouselSelector).css("overflow", "hidden");        

    // $(el_carouselSelector).append("<div id='smallWindow' style='width:90%'></div>");
    $(el_carouselSelector).append("<div id='smallWindow' style='left: 10%; width:80%'></div>");        

    var results = $("#smallWindow");
    results.addClass("owl-carousel");
    // results.css('background-color', 'yellow');

    if (results.data('owlCarousel')) {
      results.data('owlCarousel').destroy();
    }
    results.owlCarousel({
      items : NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW, //3 items above 1000px browser width
      // itemsDesktop : [1000,5], //5 items between 1000px and 901px
      // itemsDesktopSmall : [900,3], // betweem 900px and 601px
      // itemsTablet: [600,2], //2 items between 600 and 0
      // itemsMobile : false // itemsMobile disabled - inherit from itemsTablet option
       singleItem : true,
       // autoHeight : true,
       afterMove: (function() {return function() {
          var tid = indexToTid[this.currentItem];
          setTimeout(function() {
              eb.trigger(eb.commentSelected, tid);
          }, 100);

      }}())
    });
    var indexToTid = this.collection.pluck("tid");

    _.each(this.collection.first(NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW), function(c) {
      results.data('owlCarousel').addItem(
        "<div style='margin:10px; text-align:justify' class='well query_result_item'>" + 
          "<p>" +
            "Agrees: " + c.get("A") +
            " Disagrees: " + c.get("D") +
          "</p>" +
          c.get("txt") +
        "</div>");
    });
    // Auto-select the first comment.
    $(el_carouselSelector).find(".query_result_item").first().trigger("click");
  },
  initialize: function(options) {
    var that = this;

    var getTidsForGroup = options.getTidsForGroup;

    this.fetcher = options.fetcher;
    if (!this.useCarousel()) {
      $(el_carouselSelector).html("");
    }

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
      that.collection.firstFetchPromise.then(function() {
        if (gid === false) {
          that.$("#commentSearch").show();
          that.$("#commentSort").show();
          that.$("#groupStats").hide();
          that.sortEnabled = true;
          that.searchEnabled = true;
          that.visibleTids = null;
          that.sortAgree();     
          that.updateFilter();
          if (that.useCarousel()) {
            that.renderWithCarousel();
          }
          that.selectFirst();
        } else {
          that.$("#commentSearch").hide();
          that.$("#commentSort").hide();
          that.$("#groupStats").show();
          that.sortEnabled = false;
          that.searchEnabled = false;
          getTidsForGroup(gid, NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW).then(function(o) {
            that.visibleTids = o.tids;
            that.collection.updateRepness(o.tidToR);
            that.sortRepness();
            that.updateFilter();
            if (that.useCarousel()) {
              that.renderWithCarousel();
            }
            that.selectFirst();
          });
        }
      });
    });
  }
});