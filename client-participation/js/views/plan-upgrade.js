// var View = require("handlebones").View;
var template = require("../tmpl/plan-upgrade");
var PolisView = require("../lib/PolisView");

module.exports = PolisView.extend({
  name: "planUpgrade",
  template: template,
  events: {

  },
  initialize: function(options){
    this.plan_id = options.plan_id;
    this.plan_amount = 1;
    this.isPlanIndividuals = "individuals" === this.plan_id;
    this.isPlanSites = "sites" === this.plan_id;
    this.isPlanOrgs = "orgs" === this.plan_id;
    this.plan_name = {
      individuals: "Subscribe to Individual plan",
      sites: "Subscribe to Sites plan",
      orgs: "Subscribe to Orgs plan",
    }[this.plan_id];

    this.plan_amount = {
      individuals: 100*100,
      sites: 1000*100,
      // orgs:
    }[this.plan_id];

    var that = this;

    this.stripeKey = /localhost|preprod.pol.is/.test(document.domain) ? "pk_test_x6ETDQy1aCvKnaIJ2dyYFVVj" : "pk_live_zSFep14gq0gqnVkKVp6vI9eM";

    /* isn't it crystal clear what's going on here? le sigh. */
    this.listenTo(this, "render", function(){
      setTimeout(function(){

        that.$("#stripeForm").html("<script "+
          'src="https://checkout.stripe.com/checkout.js"'+
          'class="stripe-button"'+
          "data-key=\""+ that.stripeKey +"\" "+
          "data-image=\"https://pol.is/landerImages/clusters.png\" "+
          "data-name=\"pol.is\"  "+
          "data-description=\""+ that.plan_name +"\"  "+
          "data-panel-label=\"Monthly\" "+
          "data-amount\""+that.plan_amount +
          "\">   </script>  <input type=\"hidden\" name=\"plan\" value=\" " + that.plan_id + "\"></input>");

      }, 200);
    });

  }
});
