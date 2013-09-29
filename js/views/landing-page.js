define([
  'view',
  'templates/landing-page'
], function (View, template) {
  return View.extend({
    name: 'landingPage',
    template: template,
    initialize: function(){
    	this.$('body').css({'background-image': 'url(../../conductor.jpg'})
    }
  });
});
