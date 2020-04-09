// var Handlebars = require("handlebars");
// var Handlebones = require("handlebones");
var PolisModelView = require("../lib/PolisModelView");
var template = require("../tmpl/settingsEnterprise");
// var URLs = require("../util/url");

// var urlPrefix = URLs.urlPrefix;

module.exports = PolisModelView.extend({
  name: "settings",
  template: template,
  className: "settingsEnterprise",

  initialize: function(options) {
    this.model = options.model;
    this.proposal = options.proposal;
    this.teamMembers = [];

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

    this.listenTo(this, "render", function(){
      setTimeout(function(){
        $("#stripeForm").html("<script "+
          'src="https://checkout.stripe.com/checkout.js"'+
          'class="stripe-button"'+
          "data-key=\""+ that.stripeKey +"\" "+
          "data-image=\"https://pol.is/landerImages/clusters.png\" "+
          "data-name=\"pol.is\"  "+
          "data-description=\""+ "Upgrade to "+options.proposal.plan_name+" plan" +"\"  "+
          "data-panel-label=\"Monthly\" "+
          "data-amount=\""+options.proposal.monthly*100 +
          "\">   </script>  <input type=\"hidden\" name=\"plan\" value=\"" + options.proposal.plan_id + "\"></input>");


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
      "submit #addUser": function(event){
        event.preventDefault();
        var email = $(event.target).find("#teamMemberEmail").val();
        alert(email);
        this.teamMembers.push(email);
        this.render();
      },
    }
  });
