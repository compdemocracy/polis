// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var autosize = require("autosize");
var Constants = require("../util/constants");
var CurrentUserModel = require("../stores/currentUser");
var template = require("../templates/comment-form.handlebars");
var display = require("../util/display");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var M = require("../util/metrics");
var ProfilePicView = require("../views/profilePicView");
var serialize = require("../util/serialize");
var Strings = require("../strings");
var Utils = require("../util/utils");
var $ = require("jquery");
var _ = require("lodash");

var CHARACTER_LIMIT = Constants.CHARACTER_LIMIT;

// var CommentsByMeView = Handlebones.CollectionView.extend({
//   modelView: CommentView
// });

function reject() {
  return $.Deferred().reject();
}
function resolve() {
  return $.Deferred().resolve();
}

module.exports = Handlebones.ModelView.extend({
  name: "comment-form",
  template: template,

  // needed to prevent double submissions, which are annoying because they trigger a duplicate alert
  buttonActive: true,

  context: function () {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    ctx = _.extend(ctx, this, this.model && this.model.attributes);
    ctx.is_active = this.parent.model.get("is_active");
    ctx.shouldAutofocusOnTextarea = this.shouldAutofocusOnTextarea || Utils.shouldFocusOnTextareaWhenWritePaneShown();
    ctx.s = Strings;
    ctx.desktop = !display.xs();
    ctx.hideHelp = !Utils.userCanSeeHelp() || preload.firstConv.help_type === 0;
    ctx.direction = Strings.direction ? Strings.direction : "ltr";

    ctx.no_write_hint = false; //preload.firstConv.write_hint_type === 0;

    var btnBg = preload.firstConv.style_btn;
    if (btnBg) {
      ctx.customBtnStyles = "background-color: " + btnBg + ";";
    }
    ctx.charLimitString = Strings.tipCharLimit.replace("{{char_limit}}", Constants.CHARACTER_LIMIT);
    ctx.is_anon = window.preload.firstConv.is_anon;
    return ctx;
  },
  hideMessage: function (id) {
    this.$(id).hide();
  },

  showMessage: function (id) {
    // since there are now other warnings/tips showing, hide the default one
    this.$(".low_priority_tip").hide();
    this.$(id).show();
  },
  updateOneIdeaPerCommentMessage: function (formText) {
    // TODO I18N
    // Tests to see if there is non-punctuation that follows the end of a sentence.
    if ((formText || "").match(/[\?\.\!].*[a-zA-Z0-9]+/)) {
      this.showMessage("#one_idea_per_comment_message");
    } else {
      this.hideMessage("#one_idea_per_comment_message");
      this.maybeShowBasicTip();
    }
  },
  updateCharLimitExceededMessage: function (formText) {
    if (formText.length > Constants.CHARACTER_LIMIT) {
      this.showMessage("#char_limit_exceeded_message");
    } else {
      this.hideMessage("#char_limit_exceeded_message");
      this.maybeShowBasicTip();
    }
  },
  updateCommentNotQuestionAlert: function (formText) {
    if (formText.indexOf("?") >= 0) {
      this.showMessage("#commentNotQuestionAlert");
    } else {
      this.hideMessage("#commentNotQuestionAlert");
      this.maybeShowBasicTip();
    }
  },
  maybeShowBasicTip: function () {
    // if there are no other warnings/tips showing, show the default one
    if (this.$(".protip:visible").length === 0) {
      this.chooseBasicTip();
    }
  },
  chooseBasicTip: function () {
    var form = $("#comment_form_textarea");
    var formText = form.val();
    if (formText.length) {
      this.showMessage("#not_a_reply_message");
      this.hideMessage("#write_your_perspective_message");
    } else {
      this.showMessage("#write_your_perspective_message");
      this.hideMessage("#not_a_reply_message");
    }
  },
  textChange: function () {
    this.hideMessage("#comment_sent_message");
    this.hideMessage("#comment_send_failed_message");
    this.hideMessage("#comment_send_failed_empty_message");
    this.hideMessage("#comment_send_failed_too_long_message");
    this.hideMessage("#comment_send_failed_duplicate_message");
    this.hideMessage("#comment_send_failed_conversation_closed_message");
    var form = $(arguments[0].target);
    var formText = form.val();
    var len = formText.length;
    var remaining = CHARACTER_LIMIT - len;
    var num;
    var txt = "{{CHARACTERS_COUNT}}";
    if (remaining < 0) {
      // txt = "- " + remaining;
      num = -1 * remaining;
      txt = Strings.commentTooLongByChars;
      // this.$("#comment_button").attr("disabled", "disabled");
      // this.$("#comment_button").css("opacity", 0.3);
      this.showMessage("#commentTooLongAlert");
      // this.buttonActive = false;
      this.$("#commentCharCount").text("");
      this.$("#commentCharCount").hide();
      this.$("#commentCharCountExceeded").text(txt.replace("{{CHARACTERS_COUNT}}", num));
      this.$("#commentCharCountExceeded").show();
    } else {
      num = remaining;
      // this.$("#comment_button").attr("disabled", null);
      // this.$("#comment_button").css("opacity", 1);
      this.hideMessage("#commentTooLongAlert");
      this.maybeShowBasicTip();
      // this.buttonActive = true;
      // if (remaining > 0) {
      // } else {
      // }
      this.$("#commentCharCount").text(txt.replace("{{CHARACTERS_COUNT}}", num));
      this.$("#commentCharCount").show();
      this.$("#commentCharCountExceeded").text("");
      this.$("#commentCharCountExceeded").hide();
    }

    this.chooseBasicTip(formText);
    this.updateCharLimitExceededMessage(formText);
    this.updateOneIdeaPerCommentMessage(formText);
    this.updateCommentNotQuestionAlert(formText);
    eb.trigger(eb.interacted);
  },
  showFormControls: function () {
    // this.$(".alert").hide();
    this.$(".comment_form_control_hideable").show();
  },
  hideFormControls: function () {
    // this.$(".comment_form_control_hideable").hide();
    // this.$("#commentCharCount").text("");
  },
  reloadPagePreservingCommentText: function () {
    var wipCommentFormText = $("#comment_form_textarea").val();
    var params = {};
    if (wipCommentFormText.length) {
      params.wipCommentFormText = wipCommentFormText;
    }
    eb.trigger(eb.reloadWithMoreParams, params);
  },
  events: {
    "focus #comment_form_textarea": function (e) {
      // maybe on keyup ?
      this.showFormControls();
    },
    "blur #comment_form_textarea": function (e) {
      var txt = this.$("#comment_form_textarea").val();
      if (!txt || !txt.length) {
        this.hideFormControls();
      }
    },
    "change #comment_form_textarea": "textChange",
    "keyup #comment_form_textarea": "textChange",
    "paste #comment_form_textarea": "textChange",
    "click #comment_button": "onSubmitClicked"
  },
  onSubmitClicked: function (e) {
    e.preventDefault();
    this.submitComment();
  },
  submitComment: function (e) {
    var that = this;
    this.hideMessage("#comment_sent_message");
    this.hideMessage("#comment_send_failed_message");
    this.hideMessage("#comment_send_failed_empty_message");
    this.hideMessage("#comment_send_failed_too_long_message");
    this.hideMessage("#comment_send_failed_duplicate_message");
    this.hideMessage("#comment_send_failed_conversation_closed_message");

    function doSubmitComment() {
      if (that.buttonActive) {
        that.buttonActive = false;
        serialize(that, function (attrs) {
          if (attrs.txt.length === 0) {
            that.showMessage("#comment_send_failed_empty_message");
            that.buttonActive = true;
            return;
          }
          if (attrs.txt.length > CHARACTER_LIMIT) {
            that.showMessage("#comment_send_failed_too_long_message");
            that.buttonActive = true;
            return;
          }
          that
            .participantCommented(attrs)
            .then(
              function () {
                that.$("#comment_form_textarea").val("");
                that.hideFormControls();
                that.showMessage("#comment_sent_message");
              },
              function (err) {
                // that.showMessage("#comment_send_failed_message");
              }
            )
            .always(function () {
              that.buttonActive = true;
            });
        });
      }
    }
    var xid = Utils.getXid();
    var hasSocial = !_.isUndefined(xid);
    var needsSocial = false;
    M.add(M.COMMENT_SUBMIT_CLICK);
    if (hasSocial || !needsSocial) {
      M.add(M.COMMENT_SUBMIT_INIT);
      doSubmitComment();
    } else {
      M.add(M.COMMENT_SUBMIT_SOCIAL_NEEDED);
      this.showSocialAuthChoices();
    }
  },
  onAuthSuccess: function () {
    this.reloadPagePreservingCommentText();
  },
  participantCommented: function (attrs) {
    var that = this; //that = the view
    attrs.pid = -1;
    attrs.conversation_id = this.conversation_id;
    attrs.vote = Constants.REACTIONS.AGREE; // participants' comments are automatically agreed to. Needed for now since math assumes every comment has at least one vote.

    if (/^\s*$/.exec(attrs.txt)) {
      alert(Strings.commentIsEmpty);
      return reject();
    }
    if (attrs.txt.length > 997) {
      alert(Strings.commentIsTooLong);
      return reject();
    }

    // replace newlines with whitespace
    attrs.txt = attrs.txt.replace(/\n/g, " ");

    if (Utils.isDemoMode()) {
      that.showMessage("#comment_sent_message");
      that.trigger("commentSubmitted");
      return resolve();
    }

    var promise = that.serverClient.submitComment(attrs);
    if (!promise) {
      return reject();
    } else {
      promise.then(
        function () {
          that.trigger("commentSubmitted"); // view.trigger
          // $("#comment_form_textarea").hide();
          // $("#commentSentAlert").fadeIn(300);
          // setTimeout(function() {
          //   $("#commentSentAlert").fadeOut(500, function() {
          //     $("#comment_form_textarea").fadeIn(400);
          //   });
          // }, 1500);
        },
        function (err) {
          if (err.status === 409) {
            // that.model.set({
            //   error: "Duplicate!",
            //   errorExtra: "That comment already exists.",
            // });
            // alert(Strings.commentErrorDuplicate);
            that.showMessage("#comment_send_failed_duplicate_message");
          } else if (err.responseText === "polis_err_conversation_is_closed") {
            // that.model.set({
            //   error: "This conversation is closed.",
            //   errorExtra: "No further commenting is allowed.",
            // });
            // alert(Strings.commentErrorConversationClosed);
            that.showMessage("#comment_send_failed_conversation_closed_message");
          } else {
            // that.model.set({
            //   error: "Error sending comment.",
            //   errorExtra: "Please try again later.",
            // });
            // alert(Strings.commentSendFailed);
            that.showMessage("#comment_send_failed_message");
            // this.showMessage("#comment_send_failed_message");
          }
        }
      );
      return promise;
    }
  },
  initialize: function (options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model = options.model;
    this.conversation_id = options.conversation_id;
    this.collection = options.collection;
    // this.commentsByMeView = this.addChild(new CommentsByMeView({
    //   collection: options.collection
    // }));
    this.serverClient = options.serverClient;

    this.profilePicView = this.addChild(
      new ProfilePicView({
        model: CurrentUserModel
      })
    );

    if (options.wipCommentFormText) {
      this.shouldAutofocusOnTextarea = true;
    }

    var that = this;
    this.listenTo(this, "render", function () {
      setTimeout(function () {
        if (!_.isUndefined(options.wipCommentFormText)) {
          $("#comment_form_textarea").val(options.wipCommentFormText);
          eb.trigger(eb.doneUsingWipCommentFormText);
          that.submitComment();
        }
        autosize($("#comment_form_textarea"));
      }, 100);
    });
  }
});
