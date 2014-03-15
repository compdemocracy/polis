var MetadataQuestionAndAnswersFilterView = require("../views/metadataQuestionAndAnswersFilterView");
var template = require("../tmpl/metadataQuestionsFilter");
var Thorax = require("thorax");

module.exports = Thorax.CollectionView.extend({
    name: "metadataQuestionsFilterView",
    template: template,
    itemView: MetadataQuestionAndAnswersFilterView,
    allowCreate: false,
    initialize: function(options) {
      this.collection = options.collection; // questions collection

      this.query = {}; // pmqid -> [pmaid for each enabled answer]
      var notFirstRun = {}; // pmqid -> boolean
      this.listenTo(this.collection, "change:enabledAnswers", function(model) {
        var pmqid = model.get("pmqid");
        if (!notFirstRun) {
          // We don't want to make a server request since the user may not be in the analyze pane yet.
          notFirstRun[pmqid] = true;
          return;
        }
        var answers = model.get("enabledAnswers");
        this.query[pmqid] = answers;
        var allAnswers = _.chain(this.query).values().flatten().value();
        this.trigger("answersSelected", allAnswers);
      });
      this.zid = options.zid;
    }
});