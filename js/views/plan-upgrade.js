var View = require("../view");
var template = require("../tmpl/plan-upgrade");

module.exports = View.extend({
  name: "planUpgrade",
  template: template,
  events: {
  },
  initialize: function(options){
    // this.email = "foo@foo.com";
    this.plan_id = options.plan_id;
    this.plan_amount = 1;
    this.isPlanIndividuals = "individuals" === this.plan_id;
    this.isPlanSites = "sites" === this.plan_id;
    this.isPlanOrgs = "orgs" === this.plan_id;
    this.isPlanMike = "mike" === this.plan_id;
    this.plan_name = {
      individuals: "Subscribe to \"Individual\" plan",
      sites: "Subscribe to \"Sites\" plan",
      orgs: "Subscribe to \"Orgs\" plan",
      mike: "Subscribe to \"Mike\" plan",
    }[this.plan_id];
  }
});