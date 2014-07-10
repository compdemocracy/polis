var Model = require("../model");

module.exports = Model.extend({
    name: "metadataAnswers",
    urlRoot: "metadata/answers",
    idAttribute: "pmaid",
    defaults: {
        // pmaid: -1,
        // sid: -1,
        // pmqid: -1,
        // value: "",
        // checked: "checked", // TODO would be nice to use a boolean and have the template say "checked"
    }
  });