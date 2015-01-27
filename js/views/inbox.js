var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/inbox");
var inboxCollectionItemTemplate = require("../tmpl/inbox-item");
var inboxEmptyTemplate = require("../tmpl/inbox-empty");

var InboxCollectionView = Handlebones.CollectionView.extend({
  modelView: Handlebones.ModelView.extend({
    template: inboxCollectionItemTemplate
  }),
  emptyView: Handlebones.View.extend({
    tagName: "p",
    template: inboxEmptyTemplate
  })
});

module.exports = Handlebones.ModelView.extend({
  name: "inbox",
  template: template,

  initialize: function(options) {
    var that = this;
    this.showNewButton = true;
    this.hideInboxLink = true;
    this.collection = options.collection;
    this.filters = options.filters;
    this.model = options.model;

    // this.filters.is_active = options.is_active;
    // this.filters.is_draft = options.is_draft;
    this.collection.comparator = function(conversation) {
      return -new Date(conversation.get("created")).getTime();
    };
    function onFetched() {
      setTimeout(function() {
        console.warn("inbox load time", Date.now() - t);
      },0);
      that.collection.trigger('reset', that.collection, {});
      that.$(".inboxEmpty").show();
      that.$(".inboxLoading").hide();
    }
    var t = Date.now();
    this.collection.fetch({
      silent: true, // will call reset once done
      data: $.param(this.filters)
    }).then(onFetched, onFetched);
    this.inboxCollectionView = this.addChild(new InboxCollectionView({
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