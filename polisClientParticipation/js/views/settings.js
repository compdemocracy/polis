// var Backbone = require("backbone");
// var Handlebars = require("handlebars");
// var Handlebones = require("handlebones");
var PolisModelView = require("../lib/PolisModelView");
// var TwitterUserModel = require("../models/twitterUser");
var template = require("../tmpl/settings");
// var SettingsTwitterView = require("./settingsTwitter");
// var URLs = require("../util/url");
// var urlPrefix = URLs.urlPrefix;

module.exports = PolisModelView.extend({
  name: "settings",
  template: template,
  context: function() {
    var ctx = PolisModelView.prototype.context.apply(this, arguments);
    // this.model.get("site_ids").push(35234); // keep this here for testing
    ctx.hasMultipleSites = this.model.get("site_ids").length > 1;
    // ctx.pageId = (Math.random() * 1e9) << 0;
    return ctx;
  },
  initialize: function(options) {
    this.model = options.model;

    // var twitterUserModel = new TwitterUserModel({});

    // twitterUserModel.fetch();

    // this.settingsTwitter = this.addChild(new SettingsTwitterView({
    //   model: twitterUserModel
    // }));

    // -----------   BEGIN STRIPE CODE ----------------
    this.plan_id = "individuals";
    // this.plan_name = {
    //   individuals: "Upgrade to Individual plan",
    //   students: "Upgrade to Student plan",
    //   // sites: "Upgrade to Sites plan",
    //   // orgs: "Upgrade to Orgs plan",
    // }[this.plan_id];

    // this.plan_amount = {
    //   individuals: 100*100,
    //   students: 3*100,
    //   // sites: 1000*100,
    //   // orgs:
    // }[this.plan_id];

    var that = this;

    this.stripeKey = /localhost|preprod.pol.is/.test(document.domain) ? "pk_test_x6ETDQy1aCvKnaIJ2dyYFVVj" : "pk_live_zSFep14gq0gqnVkKVp6vI9eM";

    /* isn't it crystal clear what's going on here? le sigh. */
    this.listenTo(this, "render", function(){

      setTimeout(function(){

        $("#stripeForm").html("<script "+
          'src="https://checkout.stripe.com/checkout.js"'+
          'class="stripe-button"'+
          "data-key=\""+ that.stripeKey +"\" "+
          "data-image=\"https://pol.is/landerImages/clusters.png\" "+
          "data-name=\"pol.is\"  "+
          "data-description=\""+ "Upgrade to Individual plan" +"\"  "+
          "data-panel-label=\"Monthly\" "+
          "data-amount\""+100*100 +
          "\">   </script>  <input type=\"hidden\" name=\"plan\" value=\" " + "individuals" + "\"></input>");


        // New stripe hotness with fully custom forms for canvas integration
        $('#payment-form').submit(function(event) {
          var $form = $(this);

          // Disable the submit button to prevent repeated clicks
          $form.find('button').prop('disabled', true);

          Stripe.card.createToken($form, stripeResponseHandler);

          // Prevent the form from submitting with the default action
          return false;
        });

      // $("#participantsPayButton").on("click", function(ev) {
      //   var attrs = {
      //     plan: "pp", // Participants Pay
      //   };
      //   $.ajax({
      //       url: urlPrefix + "api/v3/charge",
      //       type: "POST",
      //       dataType: "json",
      //       xhrFields: {
      //           withCredentials: true
      //       },
      //       // crossDomain: true,
      //       data: attrs
      //     }).then(function(data) {
      //       // TODO ?
      //     }, function(err) {
      //       // TODO ?
      //     });
      // });



      //  $("#stripeFormStudents").html("<script "+
      //     'src="https://checkout.stripe.com/checkout.js"'+
      //     'class="stripe-button"'+
      //     "data-key=\""+ that.stripeKey +"\" "+
      //     "data-image=\"https://pol.is/landerImages/clusters.png\" "+
      //     "data-name=\"pol.is\"  "+
      //     "data-description=\""+ "Upgrade to Student plan" +"\"  "+
      //     "data-panel-label=\"Monthly\" "+
      //     "data-amount\""+3*100 +
      //     "\">   </script>  <input type=\"hidden\" name=\"plan\" value=\" " + "students" + "\"></input>");

      }, 200);

    });
    // -----------   END STRIPE CODE ----------------


  },
  events: {
    "click #addSite": function() {
      $.get("/api/v3/dummyButton?button=addAnotherSiteIdFromSettings");
      alert("coming soon");
    }
  }
});
