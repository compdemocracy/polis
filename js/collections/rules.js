var Collection = require("../collection");
var Rule = require("../models/rule");

module.exports = Collection.extend({
    name: "rules",
    url: "rules",
    model: Rule
});