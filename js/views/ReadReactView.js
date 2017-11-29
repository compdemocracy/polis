// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/readReactView");
var CommentModel = require("../models/comment");
var VoteView = require('../views/vote-view');
var PolisFacebookUtils = require('../util/facebookButton');
// var serverClient = require("../stores/polis");
// var Utils = require("../util/utils");

// var iOS = Utils.isIos();

var SHOULD_PROMPT_FOR_FB = false;
var cardNames = ["w","x","y","z"];

module.exports = Handlebones.ModelView.extend({
  name: "readReactView",
  template: template,
  events: {

    "click #fbNotNowBtn": "fbNotNowBtn",
    "click #fbNoUseBtn": "fbNoUseBtn",
    "click #fbConnectBtn": "fbConnectBtn",
    // "click #passButton": "participantPassed",

  },
  fbNotNowBtn: function() {
    // this.model.set("response", "fbnotnow");
  },
  fbNoUseBtn: function() {
    // this.model.set("response", "fbnouse");
  },
  fbConnectBtn: function() {
    PolisFacebookUtils.connect().then(function() {
      // that.model.set("response", "fbdone");
      location.reload();
    }, function(err) {
      // alert("facebook error");
    });
  },

  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    // ctx.iOS = iOS;
    var hasFacebookAttached = window.userObject.hasFacebook;

    var voteCountForFacebookPrompt = 3;

    ctx.promptFacebook = SHOULD_PROMPT_FOR_FB && !hasFacebookAttached && !this.model.get("response") && this.model.get("voteCount") > voteCountForFacebookPrompt;
    return ctx;
  },
  onVoteViewClick: function() {
    var that = this;
    var v = this.voteViews.shift();
    this.voteViews.push(v);

    var $cards = this.$el.find(".animVoteCard");
    // var $c = $cards.shift();
    // $cards.push($c);

    // var $el;

    var $c = $cards[0];
    $c.remove();
    $("#cardStack").append($c);

    // $($cards[0]).find('.comment_shower').css('visibility', 'hidden'); // css("background-color", "green");
    this.animateCardToPosition($($cards[0]), 'A');

    // setTimeout(function() {
    // }, 500);

    $($cards[0]).hide();
    // $($cards[0]).fadeOut();
    this.animateCardToPosition($($cards[1]), 0);
    this.animateCardToPosition($($cards[2]), 1);
    this.animateCardToPosition($($cards[3]), 2);
    setTimeout(function() {
      this.animateCardToPosition($($cards[0]), 3);
      $($cards[3]).fadeIn();
      // $($cards[0]).find('.comment_shower').css('visibility', 'visible'); // css("background-color", "white");
    }, 1000);

    // v.animateOut(function() {
    //   $el = $(v.el).remove();
    //   // $el = v.$el;
    //   $("#cardStack").append($el);
    //   // return v.gotoBackOfStack();
    //   for (var i = 0; i < that.voteViews.length; i++) {
    //     var vi = that.voteViews[i];
    //     that.animateCardToPosition(vi, i);
    //   }
    // });
  },


  animateCardToPosition: function($card, position) {
    // var $card = $("#card_" + cardNames[cardIndex]);
    // this.position = i;
    if (position === 0) {
      $card.attr("aria-hidden", false);
    } else {
      $card.attr("aria-hidden", true);
    }
    var classes = [
      "voteViewCardPos_0",
      "voteViewCardPos_1",
      "voteViewCardPos_2",
      "voteViewCardPos_3",
      "voteViewCardPos_A",
      "voteViewCardPos_D",
      "voteViewCardPos_P",
    ];
    var newClass = "voteViewCardPos_" + position;
    var classesToRemove = classes.filter(function(c) {
      return c !== newClass;
    });
    $card.removeClass(classesToRemove.join(" ")).addClass(newClass);
    // setTimeout(function() {
    //   this.model.set({ // trigger a render
    //     foo: i,
    //   });
    // }, 1000);
    $card.fadeIn();
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    this.model = options.model;
    this.voteViews = [];

    var commentModel = new CommentModel();

    [0,1,2,3].forEach(function(i) {
      that.voteViews.push(that.addChild(new VoteView({
        firstCommentPromise: options.firstCommentPromise,
        serverClient: options.serverClient,
        model: commentModel,
        position: i,
        orig_position: ['a','b','c'][i],
        css_position: "absolute",
        conversationModel: options.conversationModel,
        votesByMe: options.votesByMe,
        is_public: options.is_public,
        isSubscribed: options.isSubscribed,
        onVote: that.onVoteViewClick.bind(that),
        conversation_id: options.conversation_id
      })));
    });
    this.voteView_w = this.voteViews[0];
    this.voteView_x = this.voteViews[1];
    this.voteView_y = this.voteViews[2];
    this.voteView_z = this.voteViews[3];

    // hidden dummy view used to affect flow since animated views are position:absolute
    // (make sure screen readers cant see this)
    this.voteView_dummy = that.addChild(new VoteView({
      firstCommentPromise: options.firstCommentPromise,
      serverClient: options.serverClient,
      model: commentModel,
      position: 0,
      orig_position: 'y',
      hidden: true,
      css_position: "relative",
      conversationModel: options.conversationModel,
      votesByMe: options.votesByMe,
      is_public: options.is_public,
      isSubscribed: options.isSubscribed,
      onVote: that.onVoteViewClick.bind(that),
      conversation_id: options.conversation_id
    }));

    eb.on("vote", function() {
      // that.model.set("voteCount", (that.model.get("voteCount") + 1) || 1);
    });
  }
});
