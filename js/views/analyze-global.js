var AnalyzeCommentView = require("../views/analyze-comment");
var display = require("../util/display");
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

var el_carouselSelector = "#carousel";

module.exports = Thorax.CollectionView.extend({
    name: "analyze-global-view",
    template: template,
    itemView: AnalyzeCommentView,
    visibleTids: null,
    events: {
      "rendered:collection": function() {
        var first = this.collection.first();
        if (first) {
          eb.trigger(eb.commentSelected, first.get("tid"));
        }
        console.log('rendered:collection');
      },
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

  useCarousel: function() {
      return !this.isIE8 && display.xs();
  },
  hideCarousel: function() {
    this.$("#carousel").hide();
  },
  showCarousel: function() {
    this.$("#carousel").show();
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
      items : 3, //3 items above 1000px browser width
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

    _.each(this.collection.first(3), function(c) {
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
    this.collection.comparator = sortMostAgrees;
    
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
      that.renderWithCarousel();
      if (gid === false) {
        that.visibleTids = null;
        that.collection.comparator = sortMostAgrees;
        that.collection.sort();        
        that.updateFilter();
      } else {
        var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 3;
        getTidsForGroup(gid, NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW).then(function(o) {
          that.visibleTids = o.tids;
          that.collection.updateRepness(o.tidToR);
          that.collection.comparator = sortRepness;
          that.collection.sort();
          that.updateFilter();
        });
      }
    });
  }
});