var AnalyzeCommentView = require("../views/analyze-comment");
var eb = require("../eventBus");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
var Thorax = require("thorax");


module.exports = Thorax.CollectionView.extend({
    name: "analyze-global-view",
    template: template,
    itemView: AnalyzeCommentView,
    events: {
      rendered: function() {
        var that = this;
        var items = this.$(".query_result_item");
        items.on("mouseover", function() {
            $(this).addClass("hover");
        });
        items.on("mouseout", function() {
            $(this).removeClass("hover");
        });
      }
    },
  initialize: function(options) {
    var that = this;

    this.fetcher = options.fetcher;
    this.collection.comparator = function(a, b) {
      return b.get("A") - a.get("A");
    };
    this.collection.fetch({
      data: $.param({
          zid: this.zid
      }),
      processData: true,
      ajax: this.fetcher
    });
  }
});