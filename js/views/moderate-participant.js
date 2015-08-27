var Handlebones = require("handlebones");
var template = require("../tmpl/moderate-participant");
var Constants = require("../util/constants");
var eb = require("../eventBus");
var bbSave = require("../net/bbSave");


var ALLOW_MOVING_FROM_BANNED_TO_OK = true;

function onSaved() {
  eb.trigger(eb.moderatedPtpt);
}
function onFailed() {
  alert('failed to save moderation changes');
}

module.exports = Handlebones.ModelView.extend({
  name: "moderateCommentView",
  template: template,
  events: {
    "click #accept": "accept",
    "click #reject": "reject"
  },
  context: function() {
    var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
    var mod = this.model.get("mod");
    ctx.showReject = mod !== Constants.MOD.BAN;
    if (ALLOW_MOVING_FROM_BANNED_TO_OK) {
      ctx.showAccept = mod !== Constants.MOD.OK;
    } else {
      ctx.showAccept = mod === Constants.MOD.UNMODERATED;
    }
    return ctx;
  },
  allowDelete: false,
  initialize: function(options) {
    // this.model = options.model;
    this.conversation_id = options.conversation_id;
  },
  accept: function() {
    bbSave(this.model, {
      mod: Constants.MOD.OK,
      active: true
    }).then(onSaved, onFailed);
  },
  reject: function() {
    bbSave(this.model, {
      mod: Constants.MOD.BAN,
      active: true
    }).then(onSaved, onFailed);
  },

});