var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/faq");
var faqCollectionItemTemplate = require("../tmpl/faq-item");
var faqEmptyTemplate = require("../tmpl/faq-empty");
var PolisView = require("../lib/PolisView");

var FaqCollectionView = Handlebones.CollectionView.extend({
  modelView: Handlebones.ModelView.extend({
    template: faqCollectionItemTemplate
  }),
  emptyView: Handlebones.View.extend({
    tagName: "p",
    template: faqEmptyTemplate
  }),
  modelFilter: function(model, index) {
    var searchString = this.parent.searchString;
    var visibleTids = this.parent.visibleTids;
    var tidsForGroup = this.parent.tidsForGroup;
    var searchEnabled = this.parent.searchEnabled;
    var tid = model.get("tid");
    var hadTid= visibleTids.indexOf(tid) >= 0;


    if (tidsForGroup && tidsForGroup.indexOf(tid) === -1) {
      visibleTids = _.without(visibleTids, tid);
      if (hadTid) {
        this.parent.shouldNotifyForFilterChange = true; // TODO needed?
      }
      return false;
    }
    if (!_.isString(searchString) || /^\s*$/.exec(searchString)) {
      if (!hadTid) {
        this.parent.trigger("searchChanged", visibleTids);
      }
      visibleTids = _.union(visibleTids, [tid]);
      return true;
    }
    searchString = searchString
      .replace(/\s+/g, " ")
      .replace(/\s+$/,"")
      .replace(/^\s+/,"");

    var isMatch = true;
    if (searchEnabled) {
      if (_.isString(searchString)) {
        var tokens = searchString.split(/\s+/);
        // match all space separated word fragments
        var title = model.get("title").toLowerCase();
        var content = model.get("content").toLowerCase();
        var txt = title + content;
        for (var i = 0; i < tokens.length; i++) {
          var token = tokens[i].toLowerCase();

          var shouldNegateToken = token[0] === "-";
          if (shouldNegateToken) {
            token = token.slice(1);
          }
          var tokenPresent = txt.indexOf(token) >= 0;
          if (!token.length) {
            // a "-" followed by nothing should not count as present.
            tokenPresent = false;
          }
          if (
            (!tokenPresent && !shouldNegateToken) ||
            (tokenPresent && shouldNegateToken)) {
            isMatch = false;
            break;
          }
        }
      }
    }
    var doTrigger = false;
    if (isMatch) {
      visibleTids = _.union(visibleTids, [model.get("tid")]);
      if (!hadTid) {
        doTrigger = true;
      }
    } else {
      visibleTids = _.without(visibleTids, model.get("tid"));
      if (hadTid) {
        doTrigger = true;
      }
    }
    if (doTrigger) {
      this.parent.trigger("searchChanged", visibleTids);
    }
    return isMatch;
  },
});



module.exports = PolisView.extend({
    name: "faq-view",
    template: template,
    tidsForGroup: null,
    visibleTids: [],
    events: {
      "keyup input": "updateSearch",
      "propertychange input": "updateSearch",
      submit: function(e) {
        e.preventDefault();
      },
      rendered: function() {
        // var that = this;
        // var items = this.$(".query_result_item");
        // items.on("mouseover", function() {
        //     $(this).addClass("hover");
        // });
        // items.on("mouseout", function() {
        //     $(this).removeClass("hover");
        // });
      }
    },
  searchEnabled: true,
  sortEnabled: true,
  sort: function(e) {
    this.collection.sort();
  },
  updateSearch: function(e) {
    this.searchString = e.target.value;
    this.faqCollectionView.updateModelFilter();
    // this.selectFirst();
  },
  initialize: function(options) {
    var that = this;
    this.collection = options.collection;

    this.faqCollectionView = this.addChild(new FaqCollectionView({
      collection: this.collection
    }));
    
  }
});