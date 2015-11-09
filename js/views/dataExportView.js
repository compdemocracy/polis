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
    "change select": "onOptionsChanged",
  },

  onOptionsChanged: function() {
    var that = this;
    serialize(this, function(attrs) {
      var format = "csv";
      if (that.$("#format_excel")[0].checked) {
        format = "excel";
      }
      // var s = that.$("#dataExportDateForm").val();
      // var d = new Date(s);

      var year = that.$("#exportSelectYear").val();
      var month = that.$("#exportSelectMonth").val();
      var dayOfMonth = that.$("#exportSelectDay").val();
      var tz = that.$("#exportSelectTz").val();
      var dateString = [year, month, dayOfMonth, tz].join(" ");
      var d = new Date(dateString);

      that.date = d;
      that.format = format;

      that.$("#exportButton").attr("href", that.genButtonUrl({
        conversation_id: that.model.get("conversation_id"),
        format: format,
        date: d,
      }));

    });
  },
  genButtonUrl: function(ctx) {
    var url = "/api/v3/dataExport?conversation_id=" + ctx.conversation_id + "&format=" + ctx.format;
    if (ctx.date) {
      url += ("&unixTimestamp=" + ((ctx.date/1000) << 0));
    }
    return url;
  },
  context: function() {
    var ctx = _.extend({}, Handlebones.ModelView.prototype.context.apply(this, arguments));
    ctx.exportUrl = this.genButtonUrl(ctx);
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
    this.model = options.model;
    var d = new Date();
    var month = (d.getMonth() + 1) || 12;
    var year = d.getUTCFullYear() || 2030;
    var dayOfMonth = d.getDate() || 31;
    var tzKey = d.getTimezoneOffset() || 480;
    tzKey = tzKey / 60;
    var tzWasNegative = tzKey < 0;
    tzKey = Math.abs(tzKey);
    if (tzKey < 10) {
      tzKey = "0" + tzKey;
    }
    if (tzWasNegative) {
      tzKey = "UTC+" + tzKey + "00";
    } else {
      tzKey = "UTC-" + tzKey + "00";
    }

    var months = [
      {num: 1, name: "january"},
      {num: 2, name: "february"},
      {num: 3, name: "march"},
      {num: 4, name: "april"},
      {num: 5, name: "may"},
      {num: 6, name: "june"},
      {num: 7, name: "july"},
      {num: 8, name: "august"},
      {num: 9, name: "september"},
      {num: 10, name: "october"},
      {num: 11, name: "november", selected: true},
      {num: 12, name: "december"},
    ].map(function(m) {
      if (m.num === month) {
        m.selected = true;
      }
      return m;
    });

    var years = [];
    for (var i = 2012; i <= year; i++) {
      years.push({name: i, selected: i === year});
    }

    var days = [];
    for (var day = 1; day <= 31; day++) {
      days.push({name: day, selected: day === dayOfMonth});
    }
    var tzs = [
      "UTC-1200",
      "UTC-1100",
      "UTC-1000",
      "UTC-0900",
      "UTC-0800",
      "UTC-0600",
      "UTC-0500",
      "UTC-0430",
      "UTC-0400",
      "UTC-0330",
      "UTC-0300",
      "UTC-0200",
      "UTC-0100",
      "UTC+0000",
      "UTC+0100",
      "UTC+0200",
      "UTC+0300",
      "UTC+0330",
      "UTC+0400",
      "UTC+0430",
      "UTC+0500",
      "UTC+0530",
      "UTC+0600",
      "UTC+0630",
      "UTC+0700",
      "UTC+0800",
      "UTC+0830",
      "UTC+0900",
      "UTC+0930",
      "UTC+1000",
      "UTC+1030",
      "UTC+1100",
      "UTC+1200",
      "UTC+1245",
      "UTC+1300",
      "UTC+1400",
    ].map(function(s) {
      return {
        name: s,
        selected: s === tzKey,
      };
    });
    this.model.set({
      format: "csv",
      months: months,
      years: years,
      days: days,
      tzs: tzs,
    });

  }
});
