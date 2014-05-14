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

var isIE8 = navigator.userAgent.match(/MSIE [89]/);

var ModerateCommentsCollectionView = Handlebones.CollectionView.extend({
  modelView: ModerateCommentView,
  initialize: function() {
    Handlebones.CollectionView.prototype.initialize.apply(this, arguments);
    this.on("moderated", function(model, velocity) {
      console.log('moderated fired by parent', model, velocity);
    });
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

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var zid = this.zid = this.model.get("zid");
    var pid = this.pid = options.pid;
    var zinvite = this.zinvite = this.model.get("zinvite");
    var is_public = this.model.get("is_public");


    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });

    this.comments = new CommentsCollection([], {
      zid: zid
    });
    this.comments.fetch({
      data: $.param({
        moderation: true,
        zid: this.zid
      }),
      reset: false
    }).then(function(){
      that.render();
    });

    this.todoCountView = this.addChild(new TodoCountView({
      collection: this.comments
    }))

    this.listenTo(this.comments, "sync remove add", function(){
      this.todoCountView.render()
    })



    this.moderateCommentsCollectionView = this.addChild(new ModerateCommentsCollectionView({
      collection: this.comments
    }));

  } // end initialize
});