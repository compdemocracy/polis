var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var CommentFormSeedView = require("../views/comment-form-seed");
var CommentModel = require("../models/comment");
var CommentsCollection = require("../collections/comments");
var ConversationConfigView = require("../views/conversationConfigView");
var display = require("../util/display");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require('../tmpl/moderation');
var ModerateCommentView = require('../views/moderate-comment');
var ModerateParticipantView = require('../views/moderate-participant');
var countBadgeTemplate = require('../tmpl/countBadge');
var Utils = require("../util/utils");
var Constants = require("../util/constants");

var isIE8 = Utils.isIE8();

// animated title
function showThen(c, f) { return function() {document.title = c; setTimeout(f, 200);}} 

var PtptoiModel = Backbone.Model.extend({
  name: "ptptoi",
  url: "ptptois",
  urlRoot: "ptptois",
  idAttribute: "pid",
  twitter_url: function() {
    var tw = this.get("twitter");
    if (!tw) {
      return "";
    }
    return "https://twitter.com/" + tw.twitter_user_id;
  },
  defaults: {
    //tid: undefined, // comment id
    //pid: undefined, // participant id
    //txt: "This is default comment text defined in the model.",
    //created: 0
  }
});
var PtptoiCollection = Backbone.Collection.extend({
    name: "ptptois",
    url: "ptptois",
    model: PtptoiModel
});



var ModerateCommentsCollectionView = Handlebones.CollectionView.extend({
  modelView: ModerateCommentView,
  initialize: function() {
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);
  },
});

var ModerateParticipantsCollectionView = Handlebones.CollectionView.extend({
  modelView: ModerateParticipantView,
  initialize: function() {
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);
  },
})

var TodoCountView = Handlebones.View.extend({
  template: countBadgeTemplate,
  context: function(){
    return {count: this.collection.length}
  }
})

module.exports =  Handlebones.ModelView.extend({
  name: "moderationView",
  template: template,
  events: {
  },
  context: function() {
      var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
      return ctx;
  },
  updatePtptCollections: function() {
    var that = this;
    $.when(
      this.ptptsTodo.fetch({
        data: $.param({
          // moderation: true,
          mod: Constants.MOD.UNMODERATED,
          conversation_id: this.conversation_id
        }),
        reset: false
      }),
      this.ptptsAccepted.fetch({
        data: $.param({
          // moderation: true,
          mod: Constants.MOD.OK,
          conversation_id: this.conversation_id
        }),
        reset: false
      }),
      this.ptptsRejected.fetch({
        data: $.param({
          // moderation: true,
          mod: Constants.MOD.BAN,
          conversation_id: this.conversation_id
        }),
        reset: false
      })
      );

  },
  updateCollections: function() {
    var that = this;
    $.when(
      this.commentsTodo.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.UNMODERATED,
          conversation_id: this.conversation_id
        }),
        reset: false
      }),
      this.commentsAccepted.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.OK,
          conversation_id: this.conversation_id
        }),
        reset: false
      }),
      this.commentsRejected.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.BAN,
          conversation_id: this.conversation_id
        }),
        reset: false
      })
      );
    // .then(function(){
        // that.render();
      // });
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var conversation_id = this.conversation_id = this.model.get("conversation_id");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");

    eb.on(eb.moderated, _.bind(this.updateCollections, this));
    eb.on(eb.moderatedPtpt, _.bind(this.updatePtptCollections, this));

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });

    this.commentsTodo = new CommentsCollection([], {
      conversation_id: conversation_id
    });
    this.commentsAccepted = new CommentsCollection([], {
      conversation_id: conversation_id
    });
    this.commentsRejected = new CommentsCollection([], {
      conversation_id: conversation_id
    });

    this.ptptsTodo = new PtptoiCollection([], {
      conversation_id: conversation_id
    });
    this.ptptsAccepted = new PtptoiCollection([], {
      conversation_id: conversation_id
    });
    this.ptptsRejected = new PtptoiCollection([], {
      conversation_id: conversation_id
    });

    this.updateCollections();
    this.updatePtptCollections();

    this.todoCountView = this.addChild(new TodoCountView({
      collection: this.commentsTodo
    }));
    this.acceptedCountView = this.addChild(new TodoCountView({
      collection: this.commentsAccepted
    }));
    this.rejectedCountView = this.addChild(new TodoCountView({
      collection: this.commentsRejected
    }));    


    this.listenTo(this.commentsTodo, "sync remove add", function(){
      this.todoCountView.render();
      clearInterval(this.animationIntervalRef);
      if (this.commentsTodo.length) {
        this.animationIntervalRef = setInterval(showThen("_", showThen("["+this.commentsTodo.length+"]",function(){})), 1000);
      } else {
        document.title = "";
      }
    });
    this.listenTo(this.commentsAccepted, "sync remove add", function(){
      this.acceptedCountView.render();
    });
    this.listenTo(this.commentsRejected, "sync remove add", function(){
      this.rejectedCountView.render();
    });    


    this.moderateCommentsTodoCollectionView = this.addChild(new ModerateCommentsCollectionView({
      collection: this.commentsTodo
    }));
    this.moderateCommentsAcceptedCollectionView = this.addChild(new ModerateCommentsCollectionView({
      collection: this.commentsAccepted
    }));
    this.moderateCommentsRejectedCollectionView = this.addChild(new ModerateCommentsCollectionView({
      collection: this.commentsRejected
    }));

    this.moderateParticipantsTodoCollectionView = this.addChild(new ModerateParticipantsCollectionView({
      collection: this.ptptsTodo
    }));
    this.moderateParticipantsAcceptedCollectionView = this.addChild(new ModerateParticipantsCollectionView({
      collection: this.ptptsAccepted
    }));
    this.moderateParticipantsRejectedCollectionView = this.addChild(new ModerateParticipantsCollectionView({
      collection: this.ptptsRejected
    }));


    this.conversationConfigView = this.addChild(new ConversationConfigView({
      model: this.model
    }));




    this.commentsByMe = new CommentsCollection({
      conversation_id: conversation_id
    });

    this.commentForm = this.addChild(new CommentFormSeedView({
      pid: pid,
      collection: this.commentsByMe,
      conversation_id: conversation_id
    }));

    
    var pollingReference = setInterval(function() {
      // TODO don't send everything each time
      that.commentsTodo.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.UNMODERATED,
          conversation_id: that.conversation_id
        }),
        reset: false
      });
    }, 10000);

    this.listenTo(this, "remove", function () {
      clearInterval(pollingReference);
      this.moderateCommentsTodoCollectionView.remove();
      this.moderateCommentsAcceptedCollectionView.remove();
      this.moderateCommentsRejectedCollectionView.remove();
    });

  } // end initialize
});