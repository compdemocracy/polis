var eb = require("../eventBus");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");
var template = require("../tmpl/dataExportView");
var Utils = require("../util/utils");

module.exports =  Handlebones.ModelView.extend({
  name: "conversation-export-view",
  template: template,
  events: {
    "click form": "onOptionsChanged",
  },

  onOptionsChanged: function() {
    var that = this;
    serialize(this, function(attrs) {
      var format = "csv";
      if (that.$("#format_excel")[0].checked) {
        format = "excel";
      }
      that.model.set("format", format);
    });
  },

  context: function() {
    var ctx = _.extend({}, Handlebones.ModelView.prototype.context.apply(this, arguments));
    ctx.exportUrl = "/api/v3/dataExport?conversation_id=" + ctx.conversation_id + "&format=" + ctx.format;
    ctx.csv = ctx.format === "csv";
    ctx.excel = ctx.format === "excel";
    ctx.format_extension = ".zip";
    if (ctx.format === "excel") {
      ctx.format_extension = ".xlsx";
    }
    return ctx;
  },

  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model.set("format", "csv");
    this.model = options.model;
  }
});
