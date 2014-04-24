var View = require("../view");
var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/faq");
var faqCollectionItemTemplate = require("../tmpl/faq-item");
var inboxEmptyTemplate = require("../tmpl/faq-empty");

var InboxCollectionView = Handlebones.CollectionView.extend({
  modelView: Handlebones.ModelView.extend({
    template: faqCollectionItemTemplate
  }),
  emptyView: Handlebones.View.extend({
    tagName: "p",
    template: faqEmptyTemplate
  })
});

module.exports = Handlebones.View.extend({
  name: "faq",
  template: template,
  initialize: function(options) {
    // this.collection = options.collection;
    // this.filters = {};
    // this.filters.is_active = options.is_active;
    // this.filters.is_draft = options.is_draft;
    // this.collection.comparator = function(conversation) {
    //   return -new Date(conversation.get("createdAt")).getTime();
    // };
    // this.collection.fetch(this.filters);
    // this.inboxCollectionView = this.addChild(new InboxCollectionView({
    //   collection: options.collection
    // }));
  },
  events: {
  }
});