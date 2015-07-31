var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-group");
var CommentModel = require("../models/comment");
var Handlebones = require("handlebones");
var Strings = require("../strings");
var Utils = require("../util/utils");

var SHOW_MAP = false;
var SHOW_PARTICIPANTS = false;
var AnalyeGroupParticipantsView;
if (SHOW_PARTICIPANTS) {
  AnalyeGroupParticipantsView = require("../views/analyzeGroupParticipantsView");
}

var NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW = 5;

var el_carouselSelector = "#carouselForGroup";

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



module.exports = Handlebones.ModelView.extend({
    name: "analyze-global-view",
    className: "infoArea",
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
    // this.$(el_carouselSelector).hide();
  },
  showCarousel: function() {
    this.$("#commentListView").hide();
    this.$(el_carouselSelector).show();
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
    var carouselPrevDisabled = true;
    var carouselNextDisabled = false;
    // let stack breathe
    setTimeout(function() {

      var indexToTid = [];

      var info = that.groupInfo();
      if (!info.repness || !info.repness.length) {
        console.error("missing repness");
        return;
      }

      var peopleLabel = (info.count>1) ? Strings.x_people : Strings.one_person;
      peopleLabel = peopleLabel.replace("{{x}}", info.count);
      $("#numMembers").text(peopleLabel).show();
      var repnessInfo = info.repness.slice(0);

      var tids = _.pluck(repnessInfo, "tid");

      // Copy comments out of collection. don't want to sort collection, since it's shared with Analyze View.
      var comments = that.collection.models.slice(0);

      comments = _.indexBy(comments, "id"); // id is tid

      // remove tids that are not present in the comments list (for example, tids that were moderated out)
      // TODO exclude moderated-out comments from the repfull list
      tids = _.filter(tids, function(tid) {
        return !!comments[tid];
      });

      // use ordering of tids, but fetch out the comments we want.
      comments = _.map(tids, function(tid) {
        return comments[tid];
      });

      var items = _.map(comments, function(c) {
          var tid = c.get('tid');
          var repness = tidToR[tid];
          var repfullForAgree = repness["repful-for"] === "agree";
          indexToTid.push(tid);
          var header;
          var v = info.votes[tid];
          var denominator = v.S; // or maybe v.S (seen)
          if (repness["best-agree"]) {
            repfullForAgree = true;
          }
          // var denominator = info.count; // or maybe v.S (seen)
          var percent = repfullForAgree ?
            "<i class='fa fa-check-circle-o'></i> " + ((v.A / denominator * 100) >> 0) : // WARNING duplicated in analyze-comment.js
            "<i class='fa fa-ban'></i> " + ((v.D / denominator * 100) >> 0); // WARNING duplicated in analyze-comment.js
          var leClass = repfullForAgree ?
            "a":
            "d";
          var count = repfullForAgree ?
            v.A :
            v.D;
          // L10N gods forgive me
          var createdString = (new Date(c.get("created") * 1)).toString().match(/(.*?) [0-9]+:/)[1];
          var word = repfullForAgree ?
            "<span class='a'>"+Strings.pctAgreed+"</span>" :
            "<span class='d'>"+Strings.pctDisagreed+"</span>";
          word = word.replace("{{pct}}", percent);
          var bodyColor = "#333";
          var backgroundColor = "white";
          var dotColor = repfullForAgree ? "#00b54d" : "#e74c3c";
          var gradient = "";
          header =
            "<span "+
              "class='" + leClass + "'"+
              "style='"+
                "margin-right:3px;" +
                "position: relative;"+
                "left: 54px;"+
                "top: -47px;"+
                "font-size: 35px;"+
                "font-weight: 100;"+
                "'>" + word +
            "</span>" +
            "<div style='"+
              "font-size:12px;"+
              "color: gray;"+
              "position: relative;"+
              "left: 54px;"+
              "top: -47px;"+
              "'>"+
              "<strong>" + v.S + "</strong>" +
              "<em> "+Strings.xPtptsSawThisComment+" </em>" +
            "</div>" +
            "<div style='"+
              "font-size:12px;"+
              "color: gray;"+
              "position: relative;"+
              "left: 54px;"+
              "top: -47px;"+
              "'>"+
              "<strong>"+ count +"</strong>"+
              "<em> "+ (repfullForAgree ? Strings.xOfThoseAgreed: Strings.xOfthoseDisagreed)+"</em>."+
            "</div>";

          var social = c.get("social");
          var socialCtx = {
            name: Strings.anonPerson,
            img: Utils.getAnonPicUrl(),
            link: "",
            anon: true,
          };
          if (social) {
            var hasTwitter = social.screen_name;
            var hasFacebook = social.fb_name;
            if (hasFacebook) {
              socialCtx = {
                name: social.fb_name,
                img: social.fb_picture,
                link: social.fb_link,
              };
            }
            if (hasTwitter) {
              socialCtx = {
                name: social.name,
                img: social.twitter_profile_image_url_https,
                link: "https://twitter.com/" + social.screen_name,
              };
            }
          }
          var socialHtml =
            "<div>" +
              (socialCtx.anon ? "" : "<a href='"+ socialCtx.link +"'>") +
                "<img " +
                  "style='border-radius: 3px; width: 40px; border: 1px solid lightgrey; margin-right: 15px; position: relative; top: -5px;'" +
                  "src='" + socialCtx.img + "'>" +
                "</img>" +
                "<span "+
                  "style='"+
                  "font-weight: bold;"+
                  "position: relative;" +
                  // "margin-left:, 5px;" +
                  "top: -14px;" +
                  "'>" + socialCtx.name + "</span>" +
              (socialCtx.anon ? "": "</a>") +
              "<span style='"+
                "position: relative;" +
                "top: -14px;" +
                "'> "+ Strings.x_wrote +" </span>"
          "</div>";
          var html =
            "<div "+
              "style="+
                "'color:"+bodyColor+";"+
                "background-color: " + backgroundColor + ";"+
                "cursor: -moz-grab;"+
                "cursor: -webkit-grab;"+
                "cursor: grab;"+
                "' "+
              "class='query_result_item' "+
              "data-idx='"+(indexToTid.length-1) +"'>" +
              "<p style='margin-bottom:0px'>" +
                (Utils.debugCommentProjection ? c.get("tid") : "")+
                socialHtml +
              "</p>" +
              "<p " +
                "style='margin-left: 54px; position: relative; top: -38px'" +
                ">" +
                c.get("txt") +
              "</p>" +
              header +
              // '<p style="font-size: 12px; color: gray; margin-bottom: 0px;"><em>Comment submitted ' + createdString +'</em></p>' +
            "</div>";
          return {
            color: dotColor,
            html: html
          };
        });

        // let stack breathe
        setTimeout(function() {
          $(el_carouselSelector).html("");
          $(el_carouselSelector).append("<div id='smallWindowForGroup' style='left: 10%; width:80%'></div>");

          var results = $("#smallWindowForGroup");
          results.addClass("owl-carousel");

          if (results.data('owlCarousel')) {
            results.data('owlCarousel').destroy();
          }

          results.owlCarousel({
            items : NUMBER_OF_REPRESENTATIVE_COMMENTS_TO_SHOW,
             singleItem : true,
             // autoHeight : true,
           //  transitionStyle: "fade", // this should enable CSS3 transitions
            afterInit : function(elem){
              if (!isMobile) {
                this.owlControls.prependTo(elem);
              }
           // setTimeout(function() {
              $(el_carouselSelector).fadeIn("slow", function() {

                var circles = $(el_carouselSelector).find(".owl-pagination").find(".owl-page > span");
                // var colors = _.pluck(items, "color");
                // for (var i = 0; i < circles.length; i++) {
                //   var c = circles[i];
                //   $(c).css("background", colors[i]);
                // }
                circles.hide();

                if (!isMobile) {
                  $("#groupCarouselParent").find("#groupCarouselPrev").remove();
                  $("#groupCarouselParent").find("#groupCarouselNext").remove();
                  $("#groupCarouselParent").prepend('<span id="groupCarouselPrev" class="Btn-alt Btn-small Btn" style="z-index: 3; position: absolute; top: 25%; left:0%; box-shadow: none; cursor: pointer; color: black; background-color: rgba(0,0,0,0); border: none;"><i style="font-size: 48px; font-weight: bold" class="fa fa-angle-left"></i></span>');
                  $("#groupCarouselParent").append( '<span id="groupCarouselNext" class="Btn-alt Btn-small Btn" style="z-index: 3; position: absolute; top: 25%; right:0%; box-shadow: none; cursor: pointer; color: black; background-color: rgba(0,0,0,0); border: none;"><i style="font-size: 48px; font-weight: bold" class="fa fa-angle-right"></i></span>');


                  // <div id="carouselNext">next</div>")

                  $("#groupCarouselPrev").css("opacity", .2);

                  $("#groupCarouselNext").on("click", function(e) {
                    if (!carouselNextDisabled) {
                      var owl = $("#smallWindowForGroup").data('owlCarousel');
                      owl.next();
                    }
                  });

                  $("#groupCarouselPrev").on("click", function(e) {
                    if (!carouselPrevDisabled) {
                      var owl = $("#smallWindowForGroup").data('owlCarousel');
                      owl.prev();
                    }
                  });
                }


              });
            // }, 100);



            },
             afterMove: (function() {return function() {
                var tid = indexToTid[this.currentItem];

                $("#groupCarouselNext").css("opacity", 1);
                $("#groupCarouselPrev").css("opacity", 1);
                carouselPrevDisabled = false;
                carouselNextDisabled = false;
                if (this.currentItem === 0) {
                  $("#groupCarouselPrev").css("opacity", .2);
                  carouselPrevDisabled = true;
                }
                if (this.currentItem >= (items.length - 1)) {
                  $("#groupCarouselNext").css("opacity", .2);
                  carouselNextDisabled = true;
                }
                setTimeout(function() {
                    eb.trigger(eb.commentSelected, tid);
                }, 200);

            }}())
          });

          $(el_carouselSelector).on("click", function(e) {
            var owl = $("#smallWindowForGroup").data('owlCarousel');
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


  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx.selectedGroupName = Utils.getGroupNameForGid(ctx.selectedGid);
    ctx.s = Strings;
    ctx.s.heresHowGroupVoted_sub = ctx.s.heresHowGroupVoted.replace("{{GROUP_NUMBER}}", ctx.selectedGroupName);
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);

    var that = this;
    this.collection = options.collection;
    this.collection.comparator = comparatorAgree;

    if (SHOW_PARTICIPANTS) {
      this.participants = this.addChild(new AnalyeGroupParticipantsView({
        getParticipantsOfInterestForGid: options.getParticipantsOfInterestForGid,
        getGroupInfo: options.getGroupInfo,
      }));
    }

    var getTidsForGroup = options.getTidsForGroup;
    var getLocations = options.getLocations;
    var getParticipantsOfInterestForGid = options.getParticipantsOfInterestForGid;

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

        // if (SHOW_MAP) {
        //   getLocations(gid).then(function(locations) {

        //     $("#groupMap").html("");
        //     if (!locations || !locations.length) {
        //       return;
        //     }
        //     var w = $("#groupMap").width();
        //     var h = w*2/3;

        //     var polismap = d3.select("#groupMap").append("svg")
        //       .attr("width", w)
        //       .attr("height", h);

        //     var projection = d3.geo.mercator()
        //         .scale(w)
        //         // .translate([65, 100])
        //         .translate([w/2, h/2 + h/6.7])
        //         .precision(.1);

        //     var picEnter = polismap.append("image")
        //     picEnter
        //       .classed("bktv", true)
        //       .attr("x", 0)
        //       .attr("y", -h/10)
        //       .attr("height", w) // NOTE - using w instead of h
        //       .attr("width", w)
        //       .attr("xlink:href", "https://pol.is/landerImages/earth_mercator.png");

        //     polismap.selectAll("circle")
        //         .data(locations)
        //         .enter()
        //         .append("circle")
        //         .attr("r",5)
        //         .attr("fill", "blue")
        //         .attr("opacity", ".5")
        //         .attr("transform", function(d) {
        //             return "translate(" + projection([d.lng,d.lat]) + ")";
        //         });

        //   });
        // }

      });
    }
  }
});
