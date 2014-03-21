var eb = require("../eventBus");
var View = require("../view");
var template = require("../tmpl/analyze-global");
var CommentModel = require("../models/comment");
// var serverClient = require("../lib/polis");

module.exports = View.extend({
    name: "analyze-global-view",
    template: template,
    events: {
    },
  initialize: function(options) {
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