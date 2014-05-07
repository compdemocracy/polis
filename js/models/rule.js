var Model = require("../model");

module.exports = Model.extend({
  name: "rule",
  urlRoot: "rules",
  idAttribute: "rid",
  defaults: {
    // rid: 0
    // data: null // A reference to the model which the rule refers to
    // setting: null // The setting of the rule:
                     //  for example [-1,0] would be AGREE OR PASS
                     //  for example [234, 235] would mean CHOICES WITH PMAID 234 OR 235 
                     //  for example [98101, 98102] would be a subset of zipcodes
    //created: 0
  }
});