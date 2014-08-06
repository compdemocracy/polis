var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/inbox");
var inboxCollectionItemTemplate = require("../tmpl/inbox-item-api-test");
var inboxEmptyTemplate = require("../tmpl/inbox-empty");

var InboxCollectionView = Handlebones.CollectionView.extend({
  modelView: Handlebones.ModelView.extend({
    context: function() {
      var c = Handlebones.ModelView.prototype.context.apply(this, arguments);
      if (!c.topic) {
        c.topic = ""+new Date(Number(c.created));
      }
      return c;
    },
    template: inboxCollectionItemTemplate
  }),
  emptyView: Handlebones.View.extend({
    tagName: "p",
    template: inboxEmptyTemplate
  })
});

module.exports = Handlebones.View.extend({
  name: "inbox",
  template: template,
  initialize: function(options) {
    var that = this;
    this.showNewButton = true;
    this.hideInboxLink = true;
    this.collection = options.collection;
    this.filters = options.filters;
    // this.filters.is_active = options.is_active;
    // this.filters.is_draft = options.is_draft;
    this.collection.comparator = function(conversation) {
      return -new Date(conversation.get("created")).getTime();
    };
    function onFetched() {
      that.$(".inboxEmpty").show();
      that.$(".inboxLoading").hide();
    }
    this.collection.fetch({
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