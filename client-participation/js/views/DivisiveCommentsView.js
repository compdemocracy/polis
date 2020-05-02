// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Handlebones = require("handlebones");
// var CommentModel = require("../models/comment");
// var Utils = require("../util/utils");

// var template = require("../tmpl/topComments");
var itemTemplate = require("../tmpl/topCommentsItem");

var width = 60;

module.exports = Handlebones.CollectionView.extend({
  tagName: "ul",
  className: "divisive-comments-list",
  name: "divisiveCommentsView",
  modelView: Handlebones.ModelView.extend({
    tagName: "li",
    className: "top-comments-item",
    template: itemTemplate,
    events: {
      "render": "afterRender",
    },
    context: function() {
      var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
      ctx.width = width;
      ctx.percent = ctx.percentDisagree;
      ctx.color = "rgb(231, 76, 60)"; // disagree_red
      return ctx;
    },
    render: function() {
      Handlebones.ModelView.prototype.render.apply(this, arguments);
      var i = 0;
      var that = this;
      function draw() {
        var $c = that.$("canvas");
        var c = $c[0];
        if (!c && i < 100) {
          i += 1;
          setTimeout(draw, 100);
          return;
        }
        var drawCtx=c.getContext("2d");
        drawCtx.beginPath();

        var fullArc = -Math.PI * 1.999999;

        var strokeWidth = 4;
        var radius = width/2 - (strokeWidth+1);

        var top = -Math.PI/2;
        var endOfAgreeArc = fullArc * that.model.get("percentAgree") / 100 - Math.PI/2;
        var endOfDisagreeArc = - fullArc * (that.model.get("percentDisagree") / 100) - Math.PI/2;

        drawCtx.lineWidth = strokeWidth;
        drawCtx.strokeStyle = "rgb(46, 204, 113)"; // agree_green
        drawCtx.arc(width/2, width/2, radius,
          top, // arc starts at top
          endOfAgreeArc, // end angle of arc
          true // counterclockwise?
          );
        drawCtx.stroke();


        // draw disagree part
        drawCtx.strokeStyle = "rgb(231, 76, 60)"; // disagree_red
        // drawCtx.arc(width/2, width/2, radius,
        //   -Math.PI/2, // arc starts at top
        //   - fullArc * (1 - that.model.get("percentAgree") / 100) - Math.PI/2, // end angle of arc
        //   false // counterclockwise?
        //   );
        drawCtx.beginPath();

        drawCtx.arc(width/2, width/2, radius,
          top, // arc starts at top
          endOfDisagreeArc, // end angle of arc
          false // counterclockwise?
          );
        drawCtx.stroke();

        // draw pass part
        drawCtx.strokeStyle = "rgb(200, 200, 200)"; // pass_gray
        drawCtx.beginPath();
        drawCtx.arc(width/2, width/2, radius,
          endOfAgreeArc,
          endOfDisagreeArc,
          true // counterclockwise?
          );
        drawCtx.stroke();

      }
      setTimeout(draw, 100);
    },
  }),
  // template: template,
  // emptyView: Handlebones.View.extend({
  //   tagName: "li",
  //   template: Handlebars.compile("empty content"),
  // }),
  events: {
    "click #fbNotNowBtn": "fbNotNowBtn",
    "click #fbNoUseBtn": "fbNoUseBtn",
    "click #fbConnectBtn": "fbConnectBtn",
    // "click #passButton": "participantPassed",
  },

  // fbNotNowBtn: function() {
  //   this.model.set("response", "fbnotnow");
  // },
  // fbNoUseBtn: function() {
  //   this.model.set("response", "fbnouse");
  // },
  // fbConnectBtn: function() {
  //   PolisFacebookUtils.connect().then(function() {
  //     // that.model.set("response", "fbdone");
  //     location.reload();
  //   }, function(err) {
  //     // alert("facebook error");
  //   });
  // },

  // context: function() {
  //   var ctx = Handlebones.CollectionView.prototype.context.apply(this, arguments);
  //   // var hasFacebookAttached = window.userObject.hasFacebook;

  //   // var voteCountForFacebookPrompt = 3;

  //   // ctx.promptFacebook = SHOULD_PROMPT_FOR_FB && !hasFacebookAttached && !this.model.get("response") && this.model.get("voteCount") > voteCountForFacebookPrompt;
  //   return ctx;
  // },

  initialize: function(options) {
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);
    // var that = this;
    // this.model = options.model;

    // this.voteView = this.addChild(new VoteView({
    //   firstCommentPromise: options.firstCommentPromise,
    //   serverClient: options.serverClient,
    //   model: new CommentModel(),
    //   conversationModel: options.conversationModel,
    //   votesByMe: options.votesByMe,
    //   is_public: options.is_public,
    //   isSubscribed: options.isSubscribed,
    //   conversation_id: options.conversation_id
    // }));

    // eb.on("vote", function() {
    //   that.model.set("voteCount", (that.model.get("voteCount") + 1) || 1);
    // });
  }
});
