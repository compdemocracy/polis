var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-group");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");

var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var el_carouselSelector = "#carousel";


function addMultipleOwlItems(htmlStrings, targetPosition) {
    var base = this,
        i,
        position;

    if (!htmlStrings || !htmlStrings.length) {return false; }

    if (base.$elem.children().length === 0) {
        for (i = 0; i < htmlStrings.length; i++) {
          base.$elem.append(htmlStrings[i]);
        }
        base.setVars();
        return false;
    }
    base.unWrap();
    if (targetPosition === undefined || targetPosition === -1) {
        position = -1;
    } else {
        position = targetPosition;
    }
    if (position >= base.$userItems.length || position === -1) {
      for (i = 0; i < htmlStrings.length; i++) {
        base.$userItems.eq(-1).after(htmlStrings[i]);
      }
    } else {
      for (i = 0; i < htmlStrings.length; i++) {
        base.$userItems.eq(position).before(htmlStrings[i]);
      }
    }

    base.setVars();
}



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
 
    },
  searchEnabled: true,
  sortEnabled: true,

  groupInfo: function() {
    return this.parent.groupInfo();
  },

  // sort with the current comparator
  sort: function() {
    this.collection.sort();
    // this.selectFirst();
  },
  sortAgree: function(e) {
    this.collection.comparator = comparatorAgree;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortAgree");
  },
  sortDisagree: function(e) {
    this.collection.comparator = comparatorDisagree;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortDisagree");
  },
  sortDivisive: function(e) {
    this.collection.comparator = comparatorDivisive;
    this.collection.sort();
    // this.selectFirst();
    this.selectSortModes("#sortDivisive");
  },
  useCarousel: function() {
    return true;
    // return !Utils.isIE8() && display.xs();
  },
  hideCarousel: function() {
    // this.$("#commentListView").show();
    // this.$("#carousel").hide();
  },
  showCarousel: function() {
    this.$("#commentListView").hide();
    this.$("#carousel").show();
  },
  updateSearch: function(e) {
    this.searchString = e.target.value;
    this.deselectComments();
    // this.selectFirst();
  },
  deselectComments: function() {
    eb.trigger(eb.commentSelected, false);
  },
  renderWithCarousel: function(gid, tidToR) {
    var that = this;
    // let stack breathe
    setTimeout(function() {

      var indexToTid = [];

      var info = that.groupInfo();
      var repnessInfo = info.repness.slice(0);
      repnessInfo.sort(function(a, b) {
        if (a["repful-for"] === "agree" && b["repful-for"] === "disagree") {
          return -1;
        }
        if (b["repful-for"] === "agree" && a["repful-for"] === "disagree") {
          return 1;
        }
        // secondary sort is descending repness
        // TODO condider confidence values
        return b.repness - a.repness;
      });
      var tids = _.pluck(repnessInfo, "tid");


      // Copy comments out of collection. don't want to sort collection, since it's shared with Analyze View.
      var comments = that.collection.models.slice(0);
      comments = _.filter(comments, function(comment) {
        return _.contains(tids, comment.get('tid'));
      });

      comments = _.indexBy(comments, "id"); // id is tid
      // use ordering of tids, but fetch out the comments we want.
      comments = _.map(tids, function(tid) {
        return comments[tid];
      });

      // // XXX HACK - should ideally be incorporated in the primary sort that we do before truncating the array.
      // comments.sort(function(a, b) {

      //     var vA = info.votes[a.get('tid')];
      //     var vB = info.votes[b.get('tid')];
      //     var percentA = (vA.gA_total / info.count * 100);
      //     var percentB = (vB.gA_total / info.count * 100);
      //     return percentB - percentA;
      // });


      var htmlStrings = _.map(comments, function(c) {
          var tid = c.get('tid');
          var repness = tidToR[tid];
          var repfullForAgree = repness["repful-for"] === "agree";
          indexToTid.push(tid);
          var header;
          var v = info.votes[tid];

          var percent = repfullForAgree ?
            "&#9650; " + ((v.gA_total / info.count * 100) >> 0) : // WARNING duplicated in analyze-comment.js
            "&#9660; " + ((v.gD_total / info.count * 100) >> 0); // WARNING duplicated in analyze-comment.js
          var leClass = repfullForAgree ?
            "a":
            "d";
          var count = repfullForAgree ?
            v.gA_total :
            v.gD_total;
          // L10N gods forgive me
          var word = repfullForAgree ?
            "<span class='HeadingF a'>agreed</span>" :
            "<span class='HeadingF d'>disagreed</span>";
          var bodyColor = "black"; //repfullForAgree ?
            // "#20442F" :
            // "rgb(68, 33, 33)";
          var backgroundColor = "none"; //repfullForAgree ?
            // "rgba(46, 204, 84, 0.07)" :
            // "rgba(231, 76, 60, 0.05)";
          header =
              "<span class='" + leClass + " HeadingE' style='margin-right:3px'>" + percent + "% </span>" +
              "<span class='small' style='color:darkgray;'>("+ count+"/"+info.count +") of this group "+ word + "</span>";

          var html = 
            "<div style='color:"+bodyColor+"; background-color: "+backgroundColor+"; cursor: -moz-grab; cursor: -webkit-grab; cursor: grab;' class=' query_result_item' data-idx='"+(indexToTid.length-1) +"'>" + 
              "<p>" +
                header +
              "</p>" +
              c.get("txt") +
            "</div>";
          return html;
        });

        // let stack breathe
        setTimeout(function() {
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
           //  transitionStyle: "fade", // this should enable CSS3 transitions
            afterInit : function(elem){
              if (!display.xs()) {
                this.owlControls.prependTo(elem);
              }
            },
             afterMove: (function() {return function() {
                var tid = indexToTid[this.currentItem];
                setTimeout(function() {
                    eb.trigger(eb.commentSelected, tid);
                }, 200);

            }}())
          });

          $(el_carouselSelector).on("click", function(e) {
            var owl = $("#smallWindow").data('owlCarousel');
            // var $comment = $(e);
            var index = $(e.target).data("idx");
            if (_.isNumber(index)) {
              owl.goTo(index, true);
            }
            // alert(e);
          });
          addMultipleOwlItems.call(results.data('owlCarousel'), htmlStrings);
          // Auto-select the first comment.
          eb.trigger(eb.commentSelected, indexToTid[0]);
          // $(el_carouselSelector).find(".query_result_item").first().trigger("click");
        }, 0);
      }, 0);
  },
  initialize: function(options) {
    var that = this;
    this.collection = options.collection;
    this.collection.comparator = comparatorAgree;
    

    var getTidsForGroup = options.getTidsForGroup;

    this.fetcher = options.fetcher;


    // TODO MOVE THIS LOGIC TO THE GROUP-SPECIFIC CODE...
    // this is getting crappy.

    function doFetch(gid) {
      that.collection.firstFetchPromise.then(function() {
        if (gid >= 0) {
          that.$("#commentSearch").hide();
          that.$("#commentSort").hide();
          // that.$("#groupStats").show();
          that.sortEnabled = false;
          that.searchEnabled = false;
          getTidsForGroup(gid, NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW).then(function(o) {
            that.tidsForGroup = o.tids;
            that.renderWithCarousel(gid, o.tidToR);
            // that.selectFirst();
          });
        }
      });
    } // End doFetch

    if (!_.isUndefined(options.gid)) {
      doFetch(options.gid);
    } else {
      eb.on(eb.clusterClicked, function(gid) {
        doFetch(gid);
      });
    }
  }
});
