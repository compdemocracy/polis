var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/roots");
var courseCollectionItemTemplate = require("../tmpl/roots-item");
var emptyTemplate = require("../tmpl/roots-empty");
var eb = require("../eventBus");

var CourseCollectionView = Handlebones.CollectionView.extend({
  modelView: Handlebones.ModelView.extend({
    events: {
      "click .upvote": "upvote",
    },
    context: function() {
      var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
      var d = new Date(ctx.created);
      ctx.link_url = ctx.link_url || ctx.url_name_with_hostname();
      ctx.createdString = d.toLocaleDateString() + " " + d.toLocaleTimeString();
      return ctx;
    },
    upvote: function() {
      var that = this;
      $.post("/api/v3/upvotes", {
        conversation_id: this.model.get("conversation_id")
      }).then(function() {
        // alert("upvote accepted");
        // that.model.set("upvoted", true);
        // that.model.set("upvotes",  that.model.get("upvotes")+1);
        location.reload();
      }, function(err) {
        if (err.responseText === "polis_err_auth_token_not_supplied") {
          eb.trigger("upvote_but_no_auth", {
            conversation_id: that.model.get("conversation_id"),
            pathname: window.location.pathname
          });
        } else {
          alert("upvote failed");
        }
        console.dir(err);
      });
    },
    template: courseCollectionItemTemplate
  }),
  emptyView: Handlebones.View.extend({
    tagName: "p",
    template: emptyTemplate
  })
});





module.exports = Handlebones.View.extend({
  name: "course",
  template: template,
  initialize: function(options) {
    var that = this;
    this.showNewButton = true;
    this.hideInboxLink = true;
    this.collection = options.collection;



    this.filters = options.filters;
    // this.filters.is_active = options.is_active;
    // this.filters.is_draft = options.is_draft;
    // this.collection.comparator = function(cA, cB) {
    //   var now = Date.now();
    //   var forA = (now - cB.get("created")) *  cA.get("upvotes");
    //   var forB = (now - cA.get("created")) *  cB.get("upvotes");
    //   return forB - forA;
    // };
    this.collection.comparator = function(c) {
      var age = Date.now() - c.get("created");
      var itemHourAge = age / 1000 / 60 / 60;
      var gravity = 1.8; // https://news.ycombinator.com/item?id=1781013
      var selfVotePenalty = 0; //1; // currently zero to give weight to all stories, even those with only the vote from the poster. HN removes that vote, and relies on the "new" tab for initial visibility.
      var val = -(c.get("upvotes") - selfVotePenalty) / 
          (Math.pow(itemHourAge, gravity));
      return val;
    };
    function onFetched() {
      setTimeout(function() {
        console.warn("courses view load time", Date.now() - t);
      },0);
      that.collection.trigger('reset', that.collection, {});
      that.$(".collectionEmpty").show();
      that.$(".collectionLoading").hide();
    }
    var t = Date.now();
    this.collection.fetch({
      silent: true, // will call reset once done
      data: $.param(this.filters)
    }).then(onFetched, onFetched);
    this.courseCollectionView = this.addChild(new CourseCollectionView({
      collection: options.collection
    }));
  },
  events: {
    "mouseup input": function(event) {
      // :(  http://stackoverflow.com/questions/3272089/programmatically-selecting-text-in-an-input-field-on-ios-devices-mobile-safari
      setTimeout(function() {
        if (event.target) {
          if (event.target.setSelectionRange) {
            event.target.setSelectionRange(0,9999999);
          } else {
            $(event.target).select();
          }
        }
      },1);
    }
  },
  publish: function(){
    var model = $(event.target).model();
    model.save({is_active: true, is_draft: false});
  }
});
