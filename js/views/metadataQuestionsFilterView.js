define([
  "views/metadataQuestionAndAnswersFilterView",
  "templates/metadataQuestionsFilter",
  "thorax"
], function (
  MetadataQuestionAndAnswersFilterView,
  template,
  Thorax
) {
  return Thorax.CollectionView.extend({
    name: "metadataQuestionsFilterView",
    template: template,
    itemView: MetadataQuestionAndAnswersFilterView,
    allowCreate: false,
    initialize: function(options) {
      this.collection = options.collection; // questions collection

      this.query = {}; // pmqid -> [pmaid for each enabled answer]
      this.listenTo(this.collection, "change:enabledAnswers", function(model) {
        var pmqid = model.get("pmqid");
        var answers = model.get("enabledAnswers");
        this.query[pmqid] = answers;
        var allAnswers = _.chain(this.query).values().flatten().value();
        this.trigger("answersSelected", allAnswers);
      });
      this.zid = options.zid;
    }
});
});
