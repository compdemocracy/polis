var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var CommentModel = require("../models/comment");
var CommentsCollection = require("../collections/comments");
var display = require("../util/display");
var eb = require("../eventBus");
var Handlebones = require("handlebones");
var template = require('../tmpl/moderation');
var ModerateCommentView = require('../views/moderate-comment');
var countBadgeTemplate = require('../tmpl/countBadge');
var Utils = require("../util/utils");
var Constants = require("../util/constants");

var isIE8 = Utils.isIE8();

// animated title
function showThen(c, f) { return function() {document.title = c; setTimeout(f, 200);}} 



var ModerateCommentsCollectionView = Handlebones.CollectionView.extend({
  modelView: ModerateCommentView,
  initialize: function() {
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);
  },
});

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

  updateCollections: function() {
    var that = this;
    $.when(
      this.commentsTodo.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.UNMODERATED,
          zid: this.zid
        }),
        reset: false
      }),
      this.commentsAccepted.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.OK,
          zid: this.zid
        }),
        reset: false
      }),
      this.commentsRejected.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.BAN,
          zid: this.zid
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
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");

    eb.on(eb.moderated, _.bind(this.updateCollections, this));

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });

    this.commentsTodo = new CommentsCollection([], {
      zid: zid
    });
    this.commentsAccepted = new CommentsCollection([], {
      zid: zid
    });
    this.commentsRejected = new CommentsCollection([], {
      zid: zid
    });

    this.updateCollections();

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

    var pollingReference = setInterval(function() {
      // TODO don't send everything each time
      that.commentsTodo.fetch({
        data: $.param({
          moderation: true,
          mod: Constants.MOD.UNMODERATED,
          zid: that.zid
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