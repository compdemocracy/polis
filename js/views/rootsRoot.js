var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/rootsRoot");
// var emptyTemplate = require("../tmpl/roots-empty");
var eb = require("../eventBus");

module.exports = Handlebones.View.extend({
  name: "course",
  template: template,
  events: {
    "click #newContextBtn": "onCreate"
  },
  onCreate: function() {
    var that = this;
    var name = $("#newContextInput").val();
    $.post("/api/v3/contexts", {
      name: name
    }).then(function() {
      alert('created');
      that.doFetch();
    }, function(err) {
      if (err.responseText === "polis_err_auth_token_not_supplied") {
          eb.trigger("createContext_but_no_auth", {
            name: name,
            pathname: '/s/' + name // TODO: redirect doesn't seem to work
          });
        } else {
          alert("create topic failed");
        }
        console.dir(err);
    });
  },
  doFetch: function() {
    var that = this;
    // this.collection = options.collection;
    // this.filters = options.filters;

    function onFetched() {
      setTimeout(function() {
        console.warn("contexts view load time", Date.now() - t);
      },0);
      that.$(".collectionLoading").hide();
      that.render();
    }
    var t = Date.now();
    $.get("/api/v3/contexts").then(function(contexts) {
      that.contexts = contexts;
      onFetched();
    }, function(err) {
      alert("error loading");
    });
  },
  initialize: function(options) {
    this.doFetch();
  }
});
