// var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require("../tmpl/readReactView");
var CommentModel = require("../models/comment");
var VoteView = require('../views/vote-view');
// var serverClient = require("../lib/polis");
// var Utils = require("../util/utils");

// var iOS = Utils.isIos();

module.exports = Handlebones.ModelView.extend({
    name: "readReactView",
    template: template,
    events: {

      // "click #agreeButton": "participantAgreed",
      // "click #disagreeButton": "participantDisagreed",
      // "click #passButton": "participantPassed",
      
      // "hover .starbutton": function(){
      //   this.$(".starbutton").html("<i class='fa fa-star'></i>");
      // }
    },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    // ctx.iOS = iOS;

    // ctx.promptFacebook = this.voteCount > 1;
    return ctx;
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);



    this.voteView = this.addChild(new VoteView({
      firstCommentPromise: options.firstCommentPromise,
      serverClient: options.serverClient,
      model: new CommentModel(),
      conversationModel: options.conversationModel,
      votesByMe: options.votesByMe,
      is_public: options.is_public,
      pid: options.pid,
      conversation_id: options.conversation_id
    }));
  }
});
