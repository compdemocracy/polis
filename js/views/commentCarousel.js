// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var display = require("../util/display");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var Utils = require("../util/utils");

var isMobile = Utils.isMobile();


var iconFaAngleLeft = require("../tmpl/icon_fa_angle_left");
var iconFaAngleRight = require("../tmpl/icon_fa_angle_right");


function addMultipleOwlItems(htmlStrings, targetPosition) {
  var base = this,
    i,
    position;

  if (!htmlStrings || !htmlStrings.length) {
    return false;
  }

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


module.exports = Handlebones.View.extend({
  addMultipleOwlItems: addMultipleOwlItems,
  getCarouselEl: function() {
    return $("#" + this.el_carouselSelector);
  },
  getPrevButtonEl: function() {
    return $("#" + this.el_prevButton);
  },
  getNextButtonEl: function() {
    return $("#" + this.el_nextButton);
  },
  getParentEl: function() {
    return $("#" + this.el_parent);
  },
  getSmallWindowEl: function() {
    return $("#" + this.el_smallWindow);
  },
  groupInfo: function() {
    return this.parent.groupInfo();
  },
  renderItems: function(items, indexToTid) {
    var that = this;

    function updateCarouselButtons() {
      var prevEl = that.getPrevButtonEl();
      var nextEl = that.getNextButtonEl();

      nextEl.css("opacity", 1);
      prevEl.css("opacity", 1);
      that.carouselPrevDisabled = false;
      that.carouselNextDisabled = false;
      if (this.currentItem === 0) {
        prevEl.css("opacity", 0.2);
        that.carouselPrevDisabled = true;
      }
      if (this.currentItem >= (items.length - 1)) {
        nextEl.css("opacity", 0.2);
        that.carouselNextDisabled = true;
      }
    }

    var el = that.getCarouselEl();
    el.html("");
    el.append("<div id='" + that.el_smallWindow + "' style='left: 10%; width:80%'></div>");

    var results = that.getSmallWindowEl();
    results.addClass("owl-carousel");

    if (results.data('owlCarousel')) {
      results.data('owlCarousel').destroy();
    }

    results.owlCarousel({
      items: that.commentLimit,
      singleItem: true,
      // autoHeight : true,
      //  transitionStyle: "fade", // this should enable CSS3 transitions
      afterInit: function(elem) {
        var thatCarousel = this;
        if (!isMobile) {
          this.owlControls.prependTo(elem);
        }
        // setTimeout(function() {
        el.fadeIn(0, function() {

          var circles = el.find(".owl-pagination").find(".owl-page > span");
          // var colors = _.pluck(items, "color");
          // for (var i = 0; i < circles.length; i++) {
          //   var c = circles[i];
          //   $(c).css("background", colors[i]);
          // }
          circles.hide();

          var buttonOffset = display.xs() ? "-5px" : "0";

          var groupCarouselPrevHTML = '<span ' +
            'id="' + that.el_prevButton + '" ' +
            'class="Btn-alt Btn-small Btn" ' +
            'style=" ' +
            'z-index: 3;' +
            'position: absolute;' +
            'top: 40px;' +
            'left:' + buttonOffset + ';' +
            'box-shadow: none;' +
            'cursor: pointer;' +
            'color: black;' +
            'background-color: rgba(0,0,0,0);' +
            'border: none;' +
            '">' +

            '<i class="svgIcon" style="' +
            'display: inline-block;' +
            'position: relative;' +
            'margin-right: 2px;' +
            'top: 6px;' +
            'width: 48px;' +
            'fill: black;' +
            '">' + iconFaAngleLeft() + '</i>' +
            '</span>';

          var groupCarouselNextHTML = '<span ' +
            'id="' + that.el_nextButton + '" ' +
            'class="Btn-alt Btn-small Btn" ' +
            'style=" ' +
            'z-index: 3;' +
            'position: absolute;' +
            'top: 40px;' +
            'right:' + buttonOffset + ';' +
            'box-shadow: none;' +
            'cursor: pointer;' +
            'color: black;' +
            'background-color: rgba(0,0,0,0);' +
            'border: none;' +
            '">' +
            '<i class="svgIcon" style="' +
            'display: inline-block;' +
            'position: relative;' +
            'margin-right: 2px;' +
            'top: 6px;' +
            'width: 48px;' +
            'fill: black;' +
            '">' + iconFaAngleRight() + '</i>' +


            '</span>';

          that.getPrevButtonEl().remove();
          that.getNextButtonEl().remove();
          that.getParentEl().prepend(groupCarouselPrevHTML);
          that.getParentEl().append(groupCarouselNextHTML);

          updateCarouselButtons.call(thatCarousel);

          // <div id="carouselNext">next</div>")

          var prevEl = that.getPrevButtonEl();
          var nextEl = that.getNextButtonEl();

          prevEl.css("opacity", 0.2);

          nextEl.on("click", function(e) {
            if (!that.carouselNextDisabled) {
              var owl = that.getSmallWindowEl().data('owlCarousel');
              owl.next();
            }
          });

          prevEl.on("click", function(e) {
            if (!that.carouselPrevDisabled) {
              var owl = that.getSmallWindowEl().data('owlCarousel');
              owl.prev();
            }
          });


        });
        // }, 100);

      },
      afterMove: function() {
        var tid = indexToTid[this.currentItem];

        updateCarouselButtons.call(this);
        setTimeout(function() {
          eb.trigger(eb.commentSelected, tid);
        }, 200);
      }
    });

    el.on("click", function(e) {
      var owl = that.getSmallWindowEl().data('owlCarousel');
      // var $comment = $(e);
      var index = $(e.target).data("idx");
      if (_.isNumber(index)) {
        owl.goTo(index, true);
      }
      // alert(e);
    });

    that.addMultipleOwlItems.call(results.data('owlCarousel'), _.pluck(items, "html"));
    // Auto-select the first comment.
    eb.trigger(eb.commentSelected, indexToTid[0]);
    // el.find(".query_result_item").first().trigger("click");
  },


  renderWithCarousel: function() {
    var that = this;
    this.carouselPrevDisabled = true;
    this.carouselNextDisabled = false;

    // let stack breathe
    setTimeout(function() {
      var o = that.generateItemsHTML();
      var indexToTid = o.indexToTid;
      var items = o.items;
      // let stack breathe
      setTimeout(function() {
        that.renderItems(items, indexToTid);
      }, 0);
    }, 0);
  },

});
