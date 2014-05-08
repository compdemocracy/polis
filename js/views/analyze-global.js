var AnalyzeCollectionView = require("../views/analyze-global-collection-view");
var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");

var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var el_carouselSelector = "#carousel";


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
      this.analyzeCollectionView.selectFirst();
    },
  searchEnabled: true,
  sortEnabled: true,
  sortAgree: function(e) {
    this.analyzeCollectionView.sortAgree();
    this.selectSortModes("#sortAgree");
  },
  sortDisagree: function(e) {
    this.analyzeCollectionView.sortDisagree();
    this.selectSortModes("#sortDisagree");
  },
  sortDivisive: function(e) {
    this.analyzeCollectionView.sortDivisive();
    this.selectSortModes("#sortDivisive");
  },
  sortRepness: function(e) {
    this.analyzeCollectionView.sortRepness();
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
    this.analyzeCollectionView.updateModelFilter();
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
    this.collection = options.collection;

    this.analyzeCollectionView = this.addChild(new this.CV({
      collection: this.collection
    }));

    var getTidsForGroup = options.getTidsForGroup;

    this.fetcher = options.fetcher;
    if (!this.useCarousel()) {
      $(el_carouselSelector).html("");
    }


    // TODO MOVE THIS LOGIC TO THE GROUP-SPECIFIC CODE...
    // this is getting crappy.

    function doFetch(gid) {
      that.collection.firstFetchPromise.then(function() {
        if (gid === -1) {
          that.$("#commentSearch").show();
          that.$("#commentSort").show();
          that.$("#groupStats").hide();
          that.sortEnabled = true;
          that.searchEnabled = true;
          that.tidsForGroup = null;
          that.sortAgree();     
          that.analyzeCollectionView.updateModelFilter();
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
            that.tidsForGroup = o.tids;
            that.collection.updateRepness(o.tidToR);
            that.sortRepness();
            that.analyzeCollectionView.updateModelFilter();
            if (that.useCarousel()) {
              that.renderWithCarousel();
            }
            that.selectFirst();
          });
        }
      });
    }
    if (!_.isUndefined(options.gid)) {
      doFetch(options.gid);
    } else {
      eb.on(eb.clusterClicked, doFetch);
    }
  }
});
