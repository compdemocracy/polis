var AnalyzeCollectionView = require("../views/analyze-global-collection-view");
var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");

var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var SHOULD_AUTO_CLICK_FIRST_COMMENT = false;

var el_carouselSelector = "#carouselConsensus";


var isMobile = Utils.isMobile();




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
  
  renderWithCarousel: function() {
    
    this.sortAgree();

    var that = this;
    // let stack breathe
    setTimeout(function() {

      // Copy comments out of collection. don't want to sort collection, since it's shared with Analyze View.
      var commentsAll = that.collection.models.slice(0);
      // comments = _.filter(comments, function(comment) {
      //   return _.contains(tids, comment.get('tid'));
      // });
      var consensusComments = that.getTidsForConsensus();

      var tidToConsensusInfo = _.indexBy(consensusComments, "tid");

      var comments = _.filter(commentsAll, function(c) {
        return !!tidToConsensusInfo[c.get("tid")];
      });
      comments = _.map(comments, function(c) {
        c.set("p-success", tidToConsensusInfo[c.get("tid")]["p-success"]);
        return c;
      });
      comments.sort(function(a, b) {
        return b.get("p-success") - a.get("p-success");
      });

      // var agreeCount = 0;
      // if (commentsAll.length <= 6) {
      //   comments = commentsAll;
      //   // TODO just because there aren't many comments doesn't mean we should show all of them as having 'consensus'
      // } else {
      //   for (var i = 0; i < 3; i++) {
      //     comments.push(commentsAll[i]);
      //   }
      //   for (var i = 3; i >= 0; i--) {
      //     comments.push(commentsAll[(commentsAll.length-1) - i]);
      //   }
      // }
      // comments = _.indexBy(comments, "id"); // id is tid

      // // remove tids that are not present in the comments list (for example, tids that were moderated out)
      // // TODO exclude moderated-out comments from the repfull list
      // var tids = _.filter(tids, function(tid) {
      //   return !!comments[tid];
      // });
      
      // // use ordering of tids, but fetch out the comments we want.
      // var comments = _.map(tids, function(tid) {
      //   return comments[tid];
      // });

      // // XXX HACK - should ideally be incorporated in the primary sort that we do before truncating the array.
      // comments.sort(function(a, b) {

      //     var vA = info.votes[a.get('tid')];
      //     var vB = info.votes[b.get('tid')];
      //     var percentA = (vA.gA_total / info.count * 100);
      //     var percentB = (vB.gA_total / info.count * 100);
      //     return percentB - percentA;
      // });

      var indexToTid  = [];

      var items = _.map(comments, function(c) {
          var tid = c.get('tid');
          indexToTid.push(tid);
          var info = tidToConsensusInfo[tid];
          // var header;
          // // var v = info.votes[tid];
          // // var percent = repfullForAgree ?
          //   // "&#9650; " + ((v.gA_total / info.count * 100) >> 0) : // WARNING duplicated in analyze-comment.js
          //   // "&#9660; " + ((v.gD_total / info.count * 100) >> 0); // WARNING duplicated in analyze-comment.js
          // var leClass = "a";//repfullForAgree ?
          //   // "a":
          //   // "d";
          // // var count = repfullForAgree ?
          //   // v.gA_total :
          //   // v.gD_total;
          // // var word = repfullForAgree ?
          //   // "<span class='HeadingE a'>agreed</span>" :
          //   // "<span class='HeadingE d'>disagreed</span>";
          var bodyColor = "#333"; //repfullForAgree ?
          //   // "#20442F" :
          //   // "rgb(68, 33, 33)";
          var createdString = (new Date(c.get("created") * 1)).toString().match(/(.*?) [0-9]+:/)[1];

          var forAgree = !!tidToConsensusInfo[tid].a;

          var denominator = info["n-trials"];

          var percent = forAgree ?
            "&#9650; " + ((info["n-success"] / denominator * 100) >> 0) : // WARNING duplicated in analyze-comment.js
            "&#9660; " + ((info["n-success"] / denominator * 100) >> 0); // WARNING duplicated in analyze-comment.js
          var leClass = forAgree ?
            "a":
            "d";
          var count = info["n-success"];
          var createdString = (new Date(c.get("created") * 1)).toString().match(/(.*?) [0-9]+:/)[1];
          var word = forAgree ?
            "<span class='HeadingE a'>agreed</span>" :
            "<span class='HeadingE d'>disagreed</span>";
          var wordUnstyled = forAgree ? "agreed" : "disagreed";

          
          var backgroundColor = forAgree ? "rgba(46, 204, 84, 0.07)" : "rgba(246, 208, 208, 1)";
          // header =
          //     "<span class='" + leClass + " HeadingE' style='margin-right:3px'>" + percent + "% " /*+
          //     "<span class='small' style='color:darkgray;'> ("+ count+"/"+info.count +") of this group " */ + word + "</span>";

          header =
              "<span class='" + leClass + " HeadingE' style='margin-right:3px'>" + percent + "% " /*+
              "<span class='small' style='color:darkgray;'> ("+ count+"/"+info.count +") of this group " */ + word + "</span>" +
             "<div style='font-size:12px; color: gray;'><strong>" + info["n-trials"] +"</strong> <em> saw this comment. </em></div>" +
             "<div style='font-size:12px; color: gray;'><strong>"+ count +"</strong> <em> of those participants "+wordUnstyled+"</em>.</div>";
             // "<span>(of "+ v.S +"/"+ info.count +" members of this group who saw this comment)</span>";


          var backgroundColor = forAgree ? "rgba(192, 228, 180, 1)" : "rgba(246, 208, 208, 1)";
          var dotColor = forAgree ? "#00b54d" : "#e74c3c";
          var gradient = "background: linear-gradient(to bottom, "+backgroundColor+" 0%,#ffffff 200%);"; 

          var html = 
            "<div style='box-shadow: 2px 2px 1px 1px #D5D5D5; border-radius: 5px; "+gradient+" color:"+bodyColor+"; background-color: " + backgroundColor + "; cursor: -moz-grab; cursor: -webkit-grab; cursor: grab;' class=' query_result_item' data-idx='"+(indexToTid.length-1) +"'>" + 
              "<p style='margin-bottom:0px'>" +
                (Utils.debugCommentProjection ? c.get("tid") : "")+
                header +
              "</p>" +
              "<p>" +
                c.get("txt") +
              "</p>" +
              '<p style="font-size: 12px; color: gray; margin-bottom: 0px;"><em>Comment submitted ' + createdString +'</em></p>' +
            "</div>";
          return {
            html: html,
            color: dotColor
          };
        });

        // let stack breathe
        setTimeout(function() {
          $(el_carouselSelector).html("");
          // $(el_carouselSelector).css("overflow", "hidden");        

          // $(el_carouselSelector).append("<div id='smallWindow2' style='width:90%'></div>");
          $(el_carouselSelector).append("<div id='smallWindow2' style='left: 10%; width:80%'></div>");

          var results = $("#smallWindow2");
          results.addClass("owl-carousel");
          // results.css('background-color', 'yellow');


          if (results.data('owlCarousel')) {
            results.data('owlCarousel').destroy();
          }

          results.owlCarousel({
            items : 10, //3 items above 1000px browser width
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

           // setTimeout(function() {
              $(el_carouselSelector).fadeIn("slow", function() {


                var circles = $(el_carouselSelector).find(".owl-pagination").find(".owl-page > span");
                var colors = _.pluck(items, "color");
                for (var i = 0; i < circles.length; i++) {
                  var c = circles[i];
                  $(c).css("background", colors[i]);
                }

                if (!isMobile) {
                  
                  $(el_carouselSelector).find("#majorityCarouselPrev").remove();
                  $(el_carouselSelector).find("#majorityCarouselNext").remove();
                  $(el_carouselSelector).find(".owl-pagination").prepend('<button id="majorityCarouselPrev" class="Btn-alt Btn-small Btn" style="vertical-align: super; cursor: pointer; color: #0a77bf; "><i style="font-size: 16px" class="fa fa-arrow-left"></i></button>');
                  $(el_carouselSelector).find(".owl-pagination").append( '<button id="majorityCarouselNext" class="Btn-alt Btn-small Btn" style="vertical-align: super; cursor: pointer; color: #0a77bf; "><i style="font-size: 16px" class="fa fa-arrow-right"></i></button>');

                  // <div id="carouselNext">next</div>")


                  $("#majorityCarouselNext").on("click", function(e) {
                    var owl = $("#smallWindow2").data('owlCarousel');
                    owl.next();
                  });

                  $("#majorityCarouselPrev").on("click", function(e) {
                    var owl = $("#smallWindow2").data('owlCarousel');
                    owl.prev();
                  });
                }


              });
            // }, 100);


              
            },
             afterMove: (function() {return function() {
                var tid = indexToTid[this.currentItem];
                setTimeout(function() {
                    eb.trigger(eb.commentSelected, tid);
                }, 200);

            }}())
          });

          $(el_carouselSelector).on("click", function(e) {
            var owl = $("#smallWindow2").data('owlCarousel');
            // var $comment = $(e);
            var index = $(e.target).data("idx");
            if (_.isNumber(index)) {
              owl.goTo(index, true);
            }
            // alert(e);
          });

          addMultipleOwlItems.call(results.data('owlCarousel'), _.pluck(items, "html"));
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
    
    // if (!that.useCarousel()) {
    //   this.analyzeCollectionView = this.addChild(new this.CV({
    //     collection: this.collection,
    //     comparator: comparatorAgree
    //   }));
    // }

    this.getTidsForConsensus = options.getTidsForConsensus;

    this.fetcher = options.fetcher;


    // TODO MOVE THIS LOGIC TO THE GROUP-SPECIFIC CODE...
    // this is getting crappy.

    function doFetch(gid) {
      that.collection.firstFetchPromise.then(function() {
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
      });
    } // End doFetch

  }
});
