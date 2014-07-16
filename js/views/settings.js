var Handlebars = require("handlebars");
var Handlebones = require("handlebones");
var template = require("../tmpl/settings");


module.exports = Handlebones.ModelView.extend({
  name: "settings",
  template: template,
  initialize: function(options) {
    this.model = options.model;


    // -----------   BEGIN STRIPE CODE ----------------
    this.plan_id = "individuals";
    this.plan_name = {
      individuals: "Upgrade to Individual plan",
      // sites: "Upgrade to Sites plan",
      // orgs: "Upgrade to Orgs plan",
    }[this.plan_id];

    this.plan_amount = {
      individuals: 100*100,
      // sites: 1000*100,
      // orgs:
    }[this.plan_id];

    var that = this;

    this.stripeKey = /localhost|preprod.pol.is/.test(document.domain) ? "pk_test_x6ETDQy1aCvKnaIJ2dyYFVVj" : "pk_live_zSFep14gq0gqnVkKVp6vI9eM";

    /* isn't it crystal clear what's going on here? le sigh. */
    this.listenTo(this, "render", function(){
      console.log('foo')
      setTimeout(function(){

        $("#stripeForm").html("<script "+
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
    // -----------   END STRIPE CODE ----------------    


  },
  events: {
  }
});