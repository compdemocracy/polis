// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var CommentCarousel = require('./commentCarousel');
var carouselCommentMobileTemplate = require("../tmpl/carouselCommentMobile");
var carouselCommentTemplate = require("../tmpl/carouselComment");
var constants = require("../util/constants");
var display = require("../util/display");
var eb = require("../eventBus");
var template = require("../tmpl/commentCarouselGroup");
var Strings = require("../strings");
var Utils = require("../util/utils");

module.exports = CommentCarousel.extend({
  name: "comment-carousel-group-view",
  className: "infoArea",
  el_carouselSelector: "carouselForGroup",
  el_prevButton: "groupCarouselPrev",
  el_nextButton: "groupCarouselNext",
  el_parent: "groupCarouselParent",
  el_smallWindow: "smallWindowForGroup",
  SHOW_MAP: false,
  template: template,
  tidsForGroup: null,
  commentLimit: 5,


  generateItemsHTML: function() {
    var that = this;
    var selectedGroupName = _.isUndefined(that.selectedGid) ?
      "" :
      Utils.getGroupNameForGid(that.selectedGid);

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
      var repness = that.tidToR[tid];
      var repfullForAgree = repness["repful-for"] === "agree";
      indexToTid.push(tid);
      var v = info.votes[tid];
      var denominator = v.S; // or maybe v.S (seen)
      if (repness["best-agree"] && (v.A > 0)) {
        repfullForAgree = true;
      }
      // var denominator = info.count; // or maybe v.S (seen)
      var percent = repfullForAgree ?
        "<i class='fa fa-check-circle-o'></i> " + ((v.A / denominator * 100) >> 0) : // WARNING duplicated in analyze-comment.js
        "<i class='fa fa-ban'></i> " + ((v.D / denominator * 100) >> 0); // WARNING duplicated in analyze-comment.js
      var leClass = repfullForAgree ? "a": "d";
      var count = repfullForAgree ? v.A : v.D;
      // var createdString = (new Date(c.get("created") * 1)).toString().match(/(.*?) [0-9]+:/)[1];
      var agreedOrDisagreed = repfullForAgree ?
        "<span class='a'>"+ Strings.pctAgreedOfGroup+"</span>" :
        "<span class='d'>"+Strings.pctDisagreedOfGroup+"</span>";
      agreedOrDisagreed = agreedOrDisagreed.replace("{{pct}}", percent);
      agreedOrDisagreed = agreedOrDisagreed.replace("{{group}}", selectedGroupName);
      var bodyColor = "#333";
      var backgroundColor = "white";
      var dotColor = repfullForAgree ? "#00b54d" : "#e74c3c";

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
            screen_name: social.screen_name,
          };
        }
      }

      var tmpl = display.xs() ? carouselCommentMobileTemplate : carouselCommentTemplate;

      var html = tmpl({
        backgroundColor: backgroundColor,
        bodyColor: bodyColor,
        tweet_id: c.get("tweet_id"),
        s: Strings,
        txt: c.get("txt"),
        index: indexToTid.length-1,
        socialCtx: socialCtx,
        agreedOrDisagreed: agreedOrDisagreed,
        leClass: leClass,
        count: count,
        nTrials: denominator,
        repfullForAgree: repfullForAgree,
        commentCarouselMinHeight: constants.commentCarouselMinHeight,
        total: info.count,
        groupOrConversatonString: "Group " + selectedGroupName,
      });

      return {
        color: dotColor,
        html: html
      };
    });
    return {
      items: items,
      indexToTid: indexToTid,
    };
  },


  context: function() {
    var ctx = CommentCarousel.prototype.context.apply(this, arguments);
    // ctx.selectedGroupName = _.isUndefined(ctx.selectedGid) ?
    //   "" :
    //   Utils.getGroupNameForGid(ctx.selectedGid);

    if (Utils.isIphone()) {
      var w = $(document).width();
      ctx.carouselParentAdditionalStyles = "max-width:"+w+"px; overflow: hidden;";
    }


    ctx.s = Strings;
    // ctx.s.heresHowGroupVoted_sub = ctx.s.heresHowGroupVoted.replace("{{GROUP_NUMBER}}", ctx.selectedGroupName);
    return ctx;
  },


  initialize: function(options) {
    CommentCarousel.prototype.initialize.apply(this, arguments);

    // doing this since we don't want to trigger a render of the whole view.
    eb.on(eb.clusterSelectionChanged, function(gid) {
      selectedGroupName = _.isUndefined(that.selectedGid) ?
      "" :
      Utils.getGroupNameForGid(that.selectedGid);

      var str = Strings.heresHowGroupVoted.replace("{{GROUP_NUMBER}}", selectedGroupName);
      $("#analyzeGroupGroupName").text(str);
    });

    var that = this;
    this.collection = options.collection;
    var getTidsForGroup = options.getTidsForGroup;

    function doFetch(gid) {
      that.collection.firstFetchPromise.then(function() {
        if (gid >= 0) {
          getTidsForGroup(gid, that.commentLimit).then(function(o) {
            that.tidsForGroup = o.tids;
            that.tidToR = o.tidToR;
            that.selectedGid = gid;
            that.renderWithCarousel();
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
  },

});
